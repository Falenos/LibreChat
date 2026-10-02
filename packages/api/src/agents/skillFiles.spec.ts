jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockExtract = jest.fn();
jest.mock('./run', () => ({
  extractInvokedSkillsFromPayload: (...args: unknown[]) => mockExtract(...args),
}));

import { Readable } from 'stream';
import { Types } from 'mongoose';
import { primeInvokedSkills, primeSkillFiles } from './skillFiles';
import type { PrimeInvokedSkillsDeps, PrimeSkillFilesParams } from './skillFiles';

const SKILL_ID = new Types.ObjectId();
const SKILL_VERSION = 7;

function makeDeps(overrides: Partial<PrimeInvokedSkillsDeps> = {}): PrimeInvokedSkillsDeps {
  const listSkillFiles = jest.fn().mockResolvedValue([]);
  const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
    storage_session_id: 'session-x',
    files: [],
  });
  return {
    req: { user: { id: 'user-1' } } as PrimeInvokedSkillsDeps['req'],
    payload: [{ role: 'assistant', content: [] }],
    accessibleSkillIds: [SKILL_ID],
    codeEnvAvailable: true,
    getSkillByName: jest.fn().mockResolvedValue({
      _id: SKILL_ID,
      name: 'brand-guidelines',
      body: 'skill body',
      version: SKILL_VERSION,
      fileCount: 2,
    }),
    listSkillFiles,
    getStrategyFunctions: jest.fn(),
    batchUploadCodeEnvFiles,
    ...overrides,
  };
}

describe('primeInvokedSkills — execute_code capability gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtract.mockReturnValue(new Set(['brand-guidelines']));
  });

  it('skips the batch-upload path when codeEnvAvailable is false', async () => {
    const deps = makeDeps({ codeEnvAvailable: false });

    const result = await primeInvokedSkills(deps);

    expect(result.skills?.get('brand-guidelines')).toBe('skill body');
    expect(deps.listSkillFiles).not.toHaveBeenCalled();
    expect(deps.batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('enters the batch-upload path when codeEnvAvailable is true', async () => {
    const deps = makeDeps({ codeEnvAvailable: true });

    await primeInvokedSkills(deps);

    expect(deps.listSkillFiles).toHaveBeenCalledWith(SKILL_ID);
  });

  // [knauf] KK20-252 — binds the frontmatter strip to the history-reconstruction
  // path. `makeDeps` ships a frontmatter-free body ('skill body') so that the
  // surrounding cases assert on something readable; this one supplies its own so
  // that reverting `skills.set(..., r.value.body)` fails here rather than nowhere.
  //
  // The `skills` map is what `formatAgentMessages` re-injects as a user message on
  // every later turn, so it is the map — not the resolved skill object — that has
  // to arrive stripped. (`resolvedSkills` deliberately keeps the byte-faithful body
  // for the sandbox upload, but it is internal to `primeInvokedSkills` and not
  // observable from the return value, so it is not asserted here.)
  it('strips frontmatter from the body handed to formatAgentMessages', async () => {
    const raw = '---\nname: brand-guidelines\nuser-invocable: true\n---\n\n# Brand\n\nUse blue.';
    const deps = makeDeps({
      codeEnvAvailable: false,
      getSkillByName: jest.fn().mockResolvedValue({
        _id: SKILL_ID,
        name: 'brand-guidelines',
        body: raw,
        version: SKILL_VERSION,
        fileCount: 0,
      }),
    });

    const result = await primeInvokedSkills(deps);

    expect(result.skills?.get('brand-guidelines')).toBe('# Brand\n\nUse blue.');
  });
  // End [knauf]

  it('calls batchUploadCodeEnvFiles without an apiKey when files are returned', async () => {
    const fileRecords = [
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ];
    const listSkillFiles = jest.fn().mockResolvedValue(fileRecords);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'brand-guidelines/references/style.md' }],
    });

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
    });

    await primeInvokedSkills(deps);

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    const [uploadArgs] = batchUploadCodeEnvFiles.mock.calls[0];
    expect(uploadArgs).not.toHaveProperty('apiKey');
    expect(uploadArgs).not.toHaveProperty('entity_id');
    expect(uploadArgs.read_only).toBe(true);
    /* Resource identity for codeapi's sessionKey: skill files share
     * cross-user-within-tenant under `<tenant>:skill:<id>:v:<version>`.
     * Without these on the upload, codeapi falls back to user bucketing
     * and skill-cache invalidation (driven by version bump on edit)
     * never fires. See codeapi #1455 (option α). */
    expect(uploadArgs.kind).toBe('skill');
    expect(uploadArgs.id).toBe(SKILL_ID.toString());
    expect(uploadArgs.version).toBe(SKILL_VERSION);
    expect(uploadArgs.files).toHaveLength(fileRecords.length + 1);
    expect(uploadArgs.files.map((f: { filename: string }) => f.filename)).toEqual(
      expect.arrayContaining(['brand-guidelines/SKILL.md', 'brand-guidelines/references/style.md']),
    );
  });

  it('returns {} early when no skills were invoked, regardless of capability', async () => {
    mockExtract.mockReturnValue(new Set());
    const deps = makeDeps({ codeEnvAvailable: true });

    const result = await primeInvokedSkills(deps);

    expect(result).toEqual({});
    expect(deps.getSkillByName).not.toHaveBeenCalled();
  });

  it('writes kind/version/storage_session_id on every cached file after a fresh upload', async () => {
    /* Per-file refs in `CodeSessionContext.files` carry the resource
     * identity (kind=skill, id=skillId, version=skill.version) so
     * codeapi can derive the right sessionKey. Cache scope is per
     * (tenant, kind, id, version) — bumping the skill version
     * naturally invalidates the prior cache. */
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ]);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'brand-guidelines/references/style.md' }],
    });

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
    });

    const result = await primeInvokedSkills(deps);

    const codeSession = result.initialSessions?.get('execute_code');
    expect(codeSession?.files).toEqual([
      {
        id: 'file-1',
        /* `resource_id` is the skill `_id` — drives codeapi's
         * sessionKey re-derivation. Distinct from `id` (the storage
         * file_id). The split fixes the shared-kind 403 mismatch
         * where codeapi computed sessionKey from the storage nanoid
         * instead of the skill _id. */
        resource_id: SKILL_ID.toString(),
        name: 'brand-guidelines/references/style.md',
        storage_session_id: 'session-42',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('awaits updateSkillFileCodeEnvIds before resolving to avoid concurrent-prime cache misses', async () => {
    /* Concurrency regression: when many users hit the same skill at
     * once, fire-and-forget keeps the cache in miss-steady-state for
     * the burst — User N's prime reads SkillFile docs before User N-1's
     * persist commits, sees no codeEnvRef, re-uploads, and fires its
     * own forget that User N+1 also races. Awaiting the persist before
     * the prime resolves ensures the next concurrent caller observes
     * the cache pointer instead of racing a write. */
    const fileRecords = [
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ];
    const listSkillFiles = jest.fn().mockResolvedValue(fileRecords);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'brand-guidelines/references/style.md' }],
    });

    /* Defer resolution so we can assert the prime hasn't returned yet
     * — proves the call site is awaiting, not fire-and-forget. */
    let resolvePersist!: (v: { matchedCount: number; modifiedCount: number }) => void;
    const persistGate = new Promise<{ matchedCount: number; modifiedCount: number }>((r) => {
      resolvePersist = r;
    });
    const updateSkillFileCodeEnvIds = jest.fn().mockReturnValue(persistGate);

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      updateSkillFileCodeEnvIds,
    });

    let resolved = false;
    const primePromise = primeInvokedSkills(deps).then((r) => {
      resolved = true;
      return r;
    });

    /* Drain the microtask queue. The prime should still be pending
     * because persistGate hasn't resolved. */
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    /* Resolve as a successful write to confirm the prime completes
     * after the persist returns. */
    resolvePersist({ matchedCount: 1, modifiedCount: 1 });
    await primePromise;

    expect(updateSkillFileCodeEnvIds).toHaveBeenCalledTimes(1);
    const [updates] = updateSkillFileCodeEnvIds.mock.calls[0];
    expect(updates).toEqual([
      {
        skillId: SKILL_ID,
        relativePath: 'references/style.md',
        codeEnvRef: {
          kind: 'skill',
          id: SKILL_ID.toString(),
          storage_session_id: 'session-42',
          file_id: 'file-1',
          version: SKILL_VERSION,
        },
      },
    ]);
  });

  it('reads codeEnvRef in the cached-skills hot path', async () => {
    /* When all skill files are still active in codeapi, primeInvokedSkills
     * skips the batch upload entirely and reconstructs file refs from
     * each skill file's persisted `codeEnvRef`. The kind/version travel
     * through to `CodeSessionContext.files` so the next exec carries
     * them on `_injected_files` for codeapi's sessionKey derivation. */
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
        codeEnvRef: {
          kind: 'skill',
          id: SKILL_ID.toString(),
          storage_session_id: 'session-cached',
          file_id: 'file-cached',
          version: SKILL_VERSION,
        },
      },
    ]);
    const batchUploadCodeEnvFiles = jest.fn();
    const getSessionInfo = jest.fn().mockResolvedValue('2026-05-06T00:00:00Z');
    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      batchUploadCodeEnvFiles,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeInvokedSkills(deps);

    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
    expect(getSessionInfo).toHaveBeenCalledWith(
      {
        kind: 'skill',
        id: SKILL_ID.toString(),
        storage_session_id: 'session-cached',
        file_id: 'file-cached',
        version: SKILL_VERSION,
      },
      deps.req,
    );
    const codeSession = result.initialSessions?.get('execute_code');
    expect(codeSession?.files).toEqual([
      {
        id: 'file-cached',
        /* From the cache-hit path: pulls `resource_id` directly off
         * the persisted `codeEnvRef.id` (the skill `_id`). */
        resource_id: SKILL_ID.toString(),
        name: 'brand-guidelines/references/style.md',
        storage_session_id: 'session-cached',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });
});

/* The tool-invoked skill loader (`handle_skill` -> `primeSkillFiles`)
 * is a separate code path from `primeInvokedSkills` (the NL-detected
 * loader). Both feed `_injected_files` on the next /exec; both must
 * carry `resource_id` end-to-end, otherwise codeapi 400s with
 * `resource_id is invalid` (`type: 'undefined'`). Tests below lock
 * that contract on the lower-level helper directly. */
describe('primeSkillFiles — resource identity propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeSkillFilesDeps(
    overrides: Partial<PrimeSkillFilesParams> = {},
  ): PrimeSkillFilesParams {
    return {
      skill: {
        _id: SKILL_ID,
        name: 'brand-guidelines',
        body: 'skill body',
        version: SKILL_VERSION,
      },
      skillFiles: [],
      req: { user: { id: 'user-1' } } as PrimeSkillFilesParams['req'],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
      }),
      batchUploadCodeEnvFiles: jest.fn().mockResolvedValue({
        storage_session_id: 'session-fresh',
        files: [
          { fileId: 'file-fresh', filename: 'brand-guidelines/references/style.md' },
          { fileId: 'file-skillmd', filename: 'brand-guidelines/SKILL.md' },
        ],
      }),
      ...overrides,
    };
  }

  it('fresh-upload path: emits resource_id=skill._id, kind=skill, version on each file', async () => {
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
        },
      ],
    });

    const result = await primeSkillFiles(deps);

    expect(result?.files).toEqual([
      {
        id: 'file-fresh',
        resource_id: SKILL_ID.toString(),
        storage_session_id: 'session-fresh',
        name: 'brand-guidelines/references/style.md',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('cache-hit path: re-derives resource_id/kind/version from persisted codeEnvRef', async () => {
    const cachedRef = {
      kind: 'skill' as const,
      id: SKILL_ID.toString(),
      storage_session_id: 'session-cached',
      file_id: 'file-cached',
      version: SKILL_VERSION,
    };
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: cachedRef,
        },
      ],
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeSkillFiles(deps);

    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
    expect(result?.files).toEqual([
      {
        id: 'file-cached',
        resource_id: SKILL_ID.toString(),
        storage_session_id: 'session-cached',
        name: 'brand-guidelines/references/style.md',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });
});

/* [knauf] KK20-397 — staging expiry is per object (KK20-316), and code-adapter 0.4.0
 * only refreshes the files a run mounts, so one live sibling in a storage session does
 * not prove the others are live. Both primers must probe every object. */
describe('[knauf] skill-file cache probes every object', () => {
  const ref = (fileId: string) => ({
    kind: 'skill' as const,
    id: SKILL_ID.toString(),
    storage_session_id: 'session-shared',
    file_id: fileId,
    version: SKILL_VERSION,
  });
  const file = (name: string) => ({
    relativePath: `references/${name}.md`,
    filename: `${name}.md`,
    filepath: `/storage/brand-guidelines/references/${name}.md`,
    source: 's3',
    bytes: 10,
    codeEnvRef: ref(`file-${name}`),
  });
  const onlyFirstAlive = jest.fn(async (r: { file_id: string }) =>
    r.file_id === 'file-a' ? '2026-09-30T00:00:00Z' : null,
  );

  beforeEach(() => {
    onlyFirstAlive.mockClear();
  });

  it('primeSkillFiles re-uploads when one object in a shared session has expired', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-new',
      files: [],
    });
    await primeSkillFiles({
      skill: { _id: SKILL_ID, name: 'brand-guidelines', body: 'b', version: SKILL_VERSION },
      skillFiles: [file('a'), file('b')],
      req: { user: { id: 'user-1' } } as PrimeSkillFilesParams['req'],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
      }),
      batchUploadCodeEnvFiles,
      getSessionInfo: onlyFirstAlive,
      checkIfActive: () => true,
    });
    expect(onlyFirstAlive).toHaveBeenCalledTimes(2);
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
  });

  it('primeInvokedSkills re-uploads when one object in a shared session has expired', async () => {
    mockExtract.mockReturnValue(new Set(['brand-guidelines']));
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-new',
      files: [],
    });
    await primeInvokedSkills(
      makeDeps({
        listSkillFiles: jest.fn().mockResolvedValue([file('a'), file('b')]),
        getStrategyFunctions: jest.fn().mockReturnValue({
          getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
        }),
        batchUploadCodeEnvFiles,
        getSessionInfo: onlyFirstAlive,
        checkIfActive: () => true,
      }),
    );
    // Per session, only `file-a` (alive) would be probed and the stale cache reused.
    // (The upstream fallback then re-probes through primeSkillFiles, hence not 2 calls.)
    expect(onlyFirstAlive.mock.calls.map(([r]) => r.file_id)).toEqual(
      expect.arrayContaining(['file-a', 'file-b']),
    );
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
  });
});

/* [knauf] KK20-397 — a skill primed THIS turn (manual `$name`, always-apply) has no
 * `skill` call in history yet, so without `extraSkills` its bundled files were only
 * mounted from the following turn. Each carries the `_id` the resolver picked. */
describe('[knauf] primeInvokedSkills mounts files for skills primed this turn', () => {
  it('uploads the files of a skill primed only this turn', async () => {
    mockExtract.mockReturnValue(new Set());
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'scripts/karl_pptx.py',
        filename: 'karl_pptx.py',
        filepath: '/app/skill/karl-pptx/scripts/karl_pptx.py',
        source: 'deployment',
        bytes: 9,
      },
    ]);
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-new',
      files: [{ fileId: 'f-py', filename: 'karl-pptx/scripts/karl_pptx.py' }],
    });
    const result = await primeInvokedSkills(
      makeDeps({
        extraSkills: [{ name: 'karl-pptx', _id: SKILL_ID }],
        getSkillByName: jest.fn().mockResolvedValue({
          _id: SKILL_ID,
          name: 'karl-pptx',
          body: 'pptx body',
          version: 1,
          fileCount: 1,
        }),
        listSkillFiles,
        getStrategyFunctions: jest.fn().mockReturnValue({
          getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('print(1)'))),
        }),
        batchUploadCodeEnvFiles,
      }),
    );
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    expect(result.initialSessions?.get('execute_code')?.files).toEqual([
      expect.objectContaining({ name: 'karl-pptx/scripts/karl_pptx.py' }),
    ]);
  });

  // Review of #387: re-resolving by name could return a newer same-name skill, so the user
  // would see skill A's instructions while /mnt/data/<name>/ held skill B's helpers.
  it("pins this turn's prime to the exact doc the resolver picked", async () => {
    mockExtract.mockReturnValue(new Set());
    const other = new Types.ObjectId();
    const getSkillByName = jest.fn().mockResolvedValue({
      _id: SKILL_ID,
      name: 'karl-pptx',
      body: 'pptx body',
      version: 1,
      fileCount: 0,
    });
    await primeInvokedSkills(
      makeDeps({
        accessibleSkillIds: [other, SKILL_ID],
        extraSkills: [{ name: 'karl-pptx', _id: SKILL_ID }],
        getSkillByName,
      }),
    );
    expect(getSkillByName).toHaveBeenCalledTimes(1);
    const [name, ids] = getSkillByName.mock.calls[0];
    expect(name).toBe('karl-pptx');
    expect(ids.map(String)).toEqual([String(SKILL_ID)]);
  });

  it('pins a skill that is both in history and primed this turn to the primed doc', async () => {
    mockExtract.mockReturnValue(new Set(['karl-pptx']));
    const getSkillByName = jest.fn().mockResolvedValue(null);
    await primeInvokedSkills(
      makeDeps({
        accessibleSkillIds: [new Types.ObjectId(), SKILL_ID],
        extraSkills: [{ name: 'karl-pptx', _id: SKILL_ID }],
        getSkillByName,
      }),
    );
    expect(getSkillByName).toHaveBeenCalledTimes(1);
    expect(getSkillByName.mock.calls[0][1].map(String)).toEqual([String(SKILL_ID)]);
  });

  it('ignores a prime whose id the user cannot access', async () => {
    mockExtract.mockReturnValue(new Set());
    const getSkillByName = jest.fn();
    await expect(
      primeInvokedSkills(
        makeDeps({
          extraSkills: [{ name: 'karl-pptx', _id: new Types.ObjectId() }],
          getSkillByName,
        }),
      ),
    ).resolves.toEqual({});
    expect(getSkillByName).not.toHaveBeenCalled();
  });

  it('still returns early when there is neither history nor a skill primed this turn', async () => {
    mockExtract.mockReturnValue(new Set());
    const listSkillFiles = jest.fn();
    await expect(primeInvokedSkills(makeDeps({ listSkillFiles }))).resolves.toEqual({});
    expect(listSkillFiles).not.toHaveBeenCalled();
  });
});
