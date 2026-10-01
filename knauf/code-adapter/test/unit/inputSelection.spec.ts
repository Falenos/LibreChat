import { describe, expect, it } from 'vitest';
import {
  buildOmittedNote,
  mentions,
  ReferencedInputsOverBudgetError,
  selectInputs,
} from '../../src/exec/inputSelection.js';
import { StagedFileMissingError } from '../../src/exec/stagePush.js';
import { ValidationError } from '../../src/validate.js';
import { testConfig } from '../helpers/fakes.js';
import type { InputCandidate, MissingRef } from '../../src/exec/inputSelection.js';

const SESSION = 'karl-00000000000000000000000000000000';
let nextIndex = 0;

function candidate(
  finalName: string,
  opts: { size?: number; readOnly?: boolean; modified?: number; fileId?: string } = {},
): InputCandidate {
  const index = nextIndex++;
  const fileId = opts.fileId ?? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    ref: { id: fileId, name: finalName, storage_session_id: SESSION },
    doc: {
      sessionId: SESSION,
      fileId,
      filename: finalName,
      size: opts.size ?? 10,
      contentType: 'application/octet-stream',
      state: 'staged',
      origin: 'upload',
      readOnly: opts.readOnly ?? false,
      identity: { kind: 'user', id: 'u1' },
      userId: 'u1',
      tenantId: 't1',
      blobPath: `${SESSION}/${fileId}`,
      lastModified: new Date(opts.modified ?? 1_000 + index),
      expiresAt: new Date(9_999_999_999_999),
    },
    finalName,
    index,
  };
}

const missingRef = (name: string): MissingRef => ({ ref: { id: `gone-${name}`, name }, name });
const config = (overrides: Record<string, string> = {}) => testConfig(overrides).exec;
const names = (list: InputCandidate[]) => list.map((c) => c.finalName);

describe('mentions', () => {
  it('matches whole path tokens only', () => {
    expect(mentions("pd.read_csv('/mnt/data/data.csv')", 'data.csv')).toBe(true);
    expect(mentions('cat report.docx', 'report.docx')).toBe(true);
    expect(mentions('cat mydata.csv', 'data.csv')).toBe(false);
    expect(mentions('cat data.csv.bak', 'data.csv')).toBe(false);
    expect(mentions('cat data.csvx', 'data.csv')).toBe(false);
  });

  it('ignores needles too short to be meaningful', () => {
    expect(mentions('a b', 'a')).toBe(false);
  });
});

describe('selectInputs', () => {
  it('always mounts files the code names, even past a small budget of optional files', () => {
    const files = [candidate('old.csv'), candidate('a.txt'), candidate('report.docx')];
    const result = selectInputs(files, [], {
      code: 'python3 -B build.py /mnt/data/report.docx',
      args: [],
      config: config({ EXEC_INPUT_MAX_FILES: '2' }),
    });
    expect(names(result.selected)[0]).toBe('report.docx');
    expect(result.selected).toHaveLength(2);
    expect(result.omitted).toEqual([{ name: 'old.csv', reason: 'budget' }]);
  });

  it('pulls a named file’s top-level directory siblings in as mandatory (skill helpers, fonts)', () => {
    const files = [
      candidate('notes.md'),
      candidate('karl-brand/sandbox/knauf-fonts.zip'),
      candidate('karl-brand/scripts/knauf_brand.py'),
      candidate('karl-docx/scripts/karl_docx.py'),
    ];
    const result = selectInputs(files, [], {
      code: 'python3 -B /mnt/data/karl-brand/scripts/knauf_brand.py',
      args: [],
      config: config(),
    });
    expect(names(result.selected).slice(0, 2)).toEqual([
      'karl-brand/scripts/knauf_brand.py',
      'karl-brand/sandbox/knauf-fonts.zip',
    ]);
    expect(result.mandatoryCount).toBe(2);
  });

  it('treats a mentioned directory prefix as naming every file under it', () => {
    const files = [candidate('karl-docx/references/qa.md'), candidate('other.csv')];
    const result = selectInputs(files, [], {
      code: 'ls /mnt/data/karl-docx/',
      args: [],
      config: config(),
    });
    expect(result.mandatoryCount).toBe(1);
    expect(names(result.selected)[0]).toBe('karl-docx/references/qa.md');
  });

  it('keeps one copy per path, the newest', () => {
    const older = candidate('draft.docx', { modified: 1 });
    const newer = candidate('draft.docx', { modified: 2 });
    const result = selectInputs([newer, older], [], { code: '', args: [], config: config() });
    expect(result.selected).toEqual([newer]);
    expect(result.omitted).toEqual([{ name: 'draft.docx', reason: 'superseded' }]);
  });

  it('collapses one staged object sent under two names to the nested one', () => {
    const flat = candidate('x.md', { fileId: '11111111-1111-4111-8111-111111111111' });
    const nested = {
      ...flat,
      finalName: 'karl-xlsx/references/x.md',
      index: flat.index + 1,
    };
    const result = selectInputs([flat, nested], [], { code: '', args: [], config: config() });
    expect(names(result.selected)).toEqual(['karl-xlsx/references/x.md']);
  });

  // Review of #386: a basename fallback turned one exact nested path into every same-named file.
  it('selects only the exact nested path when several skills ship a file of the same name', () => {
    const files = [
      candidate('karl-docx/scripts/office_qa.py'),
      candidate('karl-pptx/scripts/office_qa.py'),
      candidate('karl-pdf/scripts/office_qa.py'),
      candidate('karl-docx/scripts/karl_docx.py'),
    ];
    const result = selectInputs(files, [], {
      code: 'python3 -B /mnt/data/karl-docx/scripts/office_qa.py page /mnt/data/r.docx 1',
      args: [],
      config: config({ EXEC_INPUT_MAX_FILES: '2' }),
    });
    expect(names(result.selected)).toEqual([
      'karl-docx/scripts/office_qa.py',
      'karl-docx/scripts/karl_docx.py',
    ]);
    expect(result.mandatoryCount).toBe(2);
  });

  it('does not count 33 same-named references as referenced when the code names one', () => {
    const files = Array.from({ length: 33 }, (_, i) =>
      candidate(`skill-${i}/references/reading.md`),
    );
    expect(() =>
      selectInputs(files, [], {
        code: "open('/mnt/data/skill-7/references/reading.md').read()",
        args: [],
        config: config(),
      }),
    ).not.toThrow();
  });

  it('still finds a nested file named by its basename or a relative path when that name is unique', () => {
    const files = [
      candidate('karl-docx/scripts/karl_docx.py'),
      candidate('karl-docx/scripts/office_qa.py'),
    ];
    for (const code of [
      'cd /mnt/data/karl-docx/scripts && python3 -B karl_docx.py qa /mnt/data/r.docx',
      'cd /mnt/data/karl-docx && python3 -B scripts/karl_docx.py qa /mnt/data/r.docx',
    ]) {
      const result = selectInputs(files, [], { code, args: [], config: config() });
      expect(result.mandatoryCount).toBe(2);
    }
  });

  it('picks no file by an ambiguous basename alone', () => {
    const files = [candidate('a/reading.md'), candidate('b/reading.md'), candidate('c.csv')];
    const result = selectInputs(files, [], {
      code: "open('reading.md')",
      args: [],
      config: config(),
    });
    expect(result.mandatoryCount).toBe(0);
  });

  it('does not fail the run over an expired file that only shares the named file’s basename', () => {
    const files = [candidate('karl-docx/references/reading.md')];
    expect(() =>
      selectInputs(files, [missingRef('karl-xlsx/references/reading.md')], {
        code: 'cat /mnt/data/karl-docx/references/reading.md',
        args: [],
        config: config(),
      }),
    ).not.toThrow();
  });

  // Review of #386: collapsing aliases must not drop the one path the code actually opens.
  it('keeps the flat alias of a staged object when the code opens that path', () => {
    const flat = candidate('x.md', { fileId: '22222222-2222-4222-8222-222222222222' });
    const nested = { ...flat, finalName: 'karl-xlsx/references/x.md', index: flat.index + 1 };
    const flatUse = selectInputs([flat, nested], [], {
      code: "open('/mnt/data/x.md')",
      args: [],
      config: config(),
    });
    expect(names(flatUse.selected)).toContain('x.md');
    const nestedUse = selectInputs([flat, nested], [], {
      code: "open('/mnt/data/karl-xlsx/references/x.md')",
      args: [],
      config: config(),
    });
    expect(names(nestedUse.selected)).toEqual(['karl-xlsx/references/x.md']);
  });

  // Review of #386 (P1): one directory must not force an unbounded serial push before user code.
  it('mounts directory siblings unconditionally only up to the sibling byte budget', () => {
    const MiB = 1024 * 1024;
    const files = [
      candidate('data/input.csv', { size: MiB }),
      ...Array.from({ length: 6 }, (_, i) =>
        candidate(`data/part-${i}.parquet`, { size: 10 * MiB }),
      ),
    ];
    const result = selectInputs(files, [], {
      code: "pd.read_csv('/mnt/data/data/input.csv')",
      args: [],
      config: config({
        EXEC_INPUT_SIBLING_MAX_BYTES: String(32 * MiB),
        EXEC_INPUT_OPTIONAL_MAX_BYTES: String(10 * MiB),
      }),
    });
    // The named file and three 10 MiB siblings; one more fits as optional, two are reported.
    expect(result.mandatoryCount).toBe(4);
    expect(result.selected).toHaveLength(5);
    expect(result.omitted.filter((o) => o.reason === 'budget')).toHaveLength(2);
  });

  it('caps how many directory siblings are mounted unconditionally', () => {
    const files = [
      candidate('karl-x/run.py'),
      ...Array.from({ length: 20 }, (_, i) => candidate(`karl-x/f${i}.md`)),
    ];
    const result = selectInputs(files, [], {
      code: 'python3 -B /mnt/data/karl-x/run.py',
      args: [],
      config: config({ EXEC_INPUT_SIBLING_MAX_FILES: '16' }),
    });
    expect(result.mandatoryCount).toBe(17);
    expect(result.selected).toHaveLength(21);
  });

  it('interleaves newest writable files with read-only ones when filling the budget', () => {
    const files = [
      candidate('w-old.csv', { modified: 1 }),
      candidate('skill/a.md', { readOnly: true }),
      candidate('w-new.csv', { modified: 9 }),
      candidate('skill/b.md', { readOnly: true }),
    ];
    const result = selectInputs(files, [], {
      code: '',
      args: [],
      config: config({ EXEC_INPUT_MAX_FILES: '3' }),
    });
    expect(names(result.selected)).toEqual(['w-new.csv', 'skill/a.md', 'w-old.csv']);
  });

  it('fails when the code names more files than one run can mount', () => {
    const files = [candidate('a.csv'), candidate('b.csv'), candidate('c.csv')];
    expect(() =>
      selectInputs(files, [], {
        code: 'cat a.csv b.csv c.csv',
        args: [],
        config: config({ EXEC_INPUT_MAX_FILES: '2' }),
      }),
    ).toThrow(ReferencedInputsOverBudgetError);
  });

  it('rejects an oversized named file but omits an oversized optional one', () => {
    const big = candidate('big.bin', { size: 100 });
    const cfg = config({ EXEC_INPUT_MAX_FILE_BYTES: '50' });
    expect(() => selectInputs([big], [], { code: 'cat big.bin', args: [], config: cfg })).toThrow(
      ValidationError,
    );
    const result = selectInputs([big], [], { code: 'echo hi', args: [], config: cfg });
    expect(result.selected).toEqual([]);
    expect(result.omitted).toEqual([{ name: 'big.bin', reason: 'too_large' }]);
  });

  it('bounds optional bytes separately from named ones', () => {
    const files = [candidate('named.bin', { size: 60 }), candidate('extra.bin', { size: 60 })];
    const result = selectInputs(files, [], {
      code: 'cat named.bin',
      args: [],
      config: config({ EXEC_INPUT_OPTIONAL_MAX_BYTES: '50' }),
    });
    expect(names(result.selected)).toEqual(['named.bin']);
    expect(result.omitted).toEqual([{ name: 'extra.bin', reason: 'budget' }]);
  });

  it('fails on an expired file the code names, skips an expired file it does not', () => {
    expect(() =>
      selectInputs([], [missingRef('gone.csv')], {
        code: "open('/mnt/data/gone.csv')",
        args: [],
        config: config(),
      }),
    ).toThrow(StagedFileMissingError);
    const result = selectInputs([], [missingRef('gone.csv')], {
      code: 'print(1)',
      args: [],
      config: config(),
    });
    expect(result.omitted).toEqual([{ name: 'gone.csv', reason: 'expired' }]);
  });

  it('never mounts a file where another selected input needs a directory', () => {
    const dir = candidate('out/data.csv');
    const file = candidate('out');
    const result = selectInputs([dir, file], [], {
      code: 'cat out/data.csv',
      args: [],
      config: config(),
    });
    expect(names(result.selected)).toEqual(['out/data.csv']);
    expect(result.omitted).toEqual([{ name: 'out', reason: 'path_conflict' }]);
  });

  it('reads args as well as code when deciding what is named', () => {
    const result = selectInputs([candidate('input.xlsx'), candidate('z.csv')], [], {
      code: 'python3 script.py "$1"',
      args: ['input.xlsx'],
      config: config({ EXEC_INPUT_MAX_FILES: '1' }),
    });
    expect(names(result.selected)).toEqual(['input.xlsx']);
  });
});

describe('buildOmittedNote', () => {
  it('names at most five unmounted files and says how to get one mounted', () => {
    const omitted = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => ({
      name: `${n}.csv`,
      reason: 'budget' as const,
    }));
    const note = buildOmittedNote(omitted, { available: 39, limit: 32 });
    expect(note).toContain('7 of 39 available files were not mounted');
    expect(note).toContain('a.csv, b.csv, c.csv, d.csv, e.csv (+2 more)');
    expect(note).toContain('/mnt/data/a.csv');
  });

  it('reports expired files as expired, not as still existing', () => {
    const note = buildOmittedNote([{ name: 'gone.csv', reason: 'expired' }], {
      available: 1,
      limit: 32,
    });
    expect(note).toContain('have expired');
    expect(note).not.toContain('still exist');
  });

  it('says nothing when the only change is that older copies were superseded', () => {
    expect(
      buildOmittedNote([{ name: 'x.docx', reason: 'superseded' }], { available: 2, limit: 32 }),
    ).toBeNull();
  });
});
