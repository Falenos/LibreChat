import { StagedFileMissingError } from './stagePush.js';
import { ValidationError } from '../validate.js';
import type { ExecFileRef } from '../types/contract.js';
import type { FileDoc } from '../store/filesRepo.js';
import type { Config } from '../config.js';

/**
 * Which of an execution's file refs are actually mounted in /mnt/data.
 *
 * WHY. LibreChat re-sends every file the thread has produced or attached on every run, with
 * no cap (packages/api/src/agents/initialize.ts, @librechat/agents ToolNode). A hard
 * "more than N inputs → fail" therefore breaks every later run of a long conversation —
 * document work (drafts, previews, skill scripts, fonts) gets there within a few turns, and
 * the model cannot fix it because it does not control the ref list. Pushes are strictly
 * sequential (see stagePush.ts), so "mount everything" is not the answer either.
 *
 * So the adapter, which is the only place that sees the final per-exec list, ranks it:
 *   P0  files the code or args name (exact path, or a unique basename) — always mounted, or fail
 *   P1  siblings under the same top-level directory as a P0    — skill helpers, fonts
 *   —   the rest, newest writable files interleaved with read-only ones, while budget lasts
 * and tells the model what it left out, so a file it needs is one exact path away.
 */

export interface InputCandidate {
  ref: ExecFileRef;
  doc: FileDoc;
  /** Path relative to /mnt/data the code expects. */
  finalName: string;
  /** Position in the request, for stable ordering. */
  index: number;
}

export interface MissingRef {
  ref: ExecFileRef;
  name: string;
}

export type OmitReason =
  | 'superseded'
  | 'path_conflict'
  | 'budget'
  | 'too_large'
  | 'expired'
  | 'push_time';

export interface OmittedInput {
  name: string;
  reason: OmitReason;
}

export interface InputSelection {
  /** Mounted inputs, highest priority first — pushes run in this order. */
  selected: InputCandidate[];
  /** The leading `selected` entries the push deadline may not skip (P0 + P1). */
  mandatoryCount: number;
  omitted: OmittedInput[];
}

/** The code names more files than one run can mount. Not retryable unchanged. */
export class ReferencedInputsOverBudgetError extends Error {
  constructor(
    public readonly referenced: number,
    public readonly limit: number,
  ) {
    super(`code references ${referenced} input files, limit ${limit}`);
    this.name = 'ReferencedInputsOverBudgetError';
  }
}

const NAME_CHAR = /[A-Za-z0-9_.-]/;
const MIN_MENTION_LENGTH = 3;

/** `needle` appears in `hay` as a whole path token (not inside a longer file name). */
export function mentions(hay: string, needle: string): boolean {
  if (needle.length < MIN_MENTION_LENGTH) {
    return false;
  }
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay[at + needle.length] ?? '';
    if ((before === '' || !NAME_CHAR.test(before)) && (after === '' || !NAME_CHAR.test(after))) {
      return true;
    }
    from = at + 1;
  }
}

function mentionsDir(hay: string, dir: string): boolean {
  if (dir.length < MIN_MENTION_LENGTH) {
    return false;
  }
  const token = `${dir}/`;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(token, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : hay[at - 1]!;
    if (before === '' || !NAME_CHAR.test(before)) {
      return true;
    }
    from = at + 1;
  }
}

/** Characters of a path token, for finding where the token around a match starts. */
const PATH_CHAR = /[A-Za-z0-9_.\-/]/;

/**
 * How the code names `needle`: `exact` when some occurrence is the whole path — bare,
 * `./`-relative or under `/mnt/data/` — and `suffix` when it only ends a longer path
 * (`/mnt/data/karl-docx/references/reading.md` names `reading.md` only as a suffix).
 */
export function mentionStrength(hay: string, needle: string): 'exact' | 'suffix' | null {
  if (needle.length < MIN_MENTION_LENGTH) {
    return null;
  }
  let strength: 'suffix' | null = null;
  for (let from = 0; ; ) {
    const at = hay.indexOf(needle, from);
    if (at < 0) {
      return strength;
    }
    from = at + 1;
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay[at + needle.length] ?? '';
    if ((before !== '' && NAME_CHAR.test(before)) || (after !== '' && NAME_CHAR.test(after))) {
      continue;
    }
    if (before !== '/') {
      return 'exact';
    }
    let start = at;
    while (start > 0 && PATH_CHAR.test(hay[start - 1]!)) {
      start -= 1;
    }
    const prefix = hay.slice(start, at);
    if (prefix === './' || prefix === '/mnt/data/' || prefix.endsWith('/mnt/data/')) {
      return 'exact';
    }
    strength = 'suffix';
  }
}

const basename = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

/**
 * The names the code asks for. A name is referenced when the code contains that exact path.
 * Failing that, it counts when the code names it only by a trailing part (`run.py` after a
 * `cd`, `scripts/run.py`) and no other input has the same file name: otherwise naming one
 * skill's `references/reading.md` would select every skill's `reading.md`, and through P1 all
 * of their siblings too.
 */
function referencedNames(hay: string, all: string[]): Set<string> {
  const unique = [...new Set(all)];
  const exact = new Set(unique.filter((name) => mentionStrength(hay, name) === 'exact'));
  const byBase = new Map<string, string[]>();
  for (const name of unique) {
    byBase.set(basename(name), [...(byBase.get(basename(name)) ?? []), name]);
  }
  const referenced = new Set(exact);
  for (const [base, group] of byBase) {
    const only = group.length === 1 ? group[0]! : null;
    if (only != null && !exact.has(only) && mentionStrength(hay, base) != null) {
      referenced.add(only);
    }
  }
  return referenced;
}
const topDir = (name: string): string | null =>
  name.includes('/') ? name.slice(0, name.indexOf('/')) : null;

/**
 * One candidate per staged object sent under several names, preferring the nested (more
 * specific) name — plus any other alias the code opens, so `/mnt/data/x.md` still exists when
 * the same object also arrived as `karl-xlsx/references/x.md`.
 */
function collapseDuplicates(found: InputCandidate[], referenced: Set<string>): InputCandidate[] {
  const byObject = new Map<string, InputCandidate[]>();
  for (const candidate of found) {
    const key = `${candidate.doc.sessionId}:${candidate.doc.fileId}`;
    byObject.set(key, [...(byObject.get(key) ?? []), candidate]);
  }
  const kept: InputCandidate[] = [];
  for (const aliases of byObject.values()) {
    const preferred = aliases.find((c) => c.finalName.includes('/')) ?? aliases[0]!;
    kept.push(preferred);
    for (const alias of aliases) {
      if (
        alias !== preferred &&
        alias.finalName !== preferred.finalName &&
        referenced.has(alias.finalName)
      ) {
        kept.push(alias);
      }
    }
  }
  return kept.sort((a, b) => a.index - b.index);
}

/** One candidate per path: the newest version wins, ties go to the later ref. */
function supersede(found: InputCandidate[], omitted: OmittedInput[]): InputCandidate[] {
  const byName = new Map<string, InputCandidate>();
  for (const candidate of found) {
    const existing = byName.get(candidate.finalName);
    if (existing == null) {
      byName.set(candidate.finalName, candidate);
      continue;
    }
    const newer =
      candidate.doc.lastModified.getTime() >= existing.doc.lastModified.getTime()
        ? candidate
        : existing;
    byName.set(candidate.finalName, newer);
    omitted.push({ name: candidate.finalName, reason: 'superseded' });
  }
  return [...byName.values()].sort((a, b) => a.index - b.index);
}

/** Newest writable files interleaved with read-only ones, so neither starves the other. */
function optionalOrder(rest: InputCandidate[]): InputCandidate[] {
  const writable = rest
    .filter((c) => !c.doc.readOnly)
    .sort(
      (a, b) => b.doc.lastModified.getTime() - a.doc.lastModified.getTime() || b.index - a.index,
    );
  const readOnly = rest.filter((c) => c.doc.readOnly);
  const ordered: InputCandidate[] = [];
  for (let i = 0; i < Math.max(writable.length, readOnly.length); i += 1) {
    if (i < writable.length) {
      ordered.push(writable[i]!);
    }
    if (i < readOnly.length) {
      ordered.push(readOnly[i]!);
    }
  }
  return ordered;
}

/** `a` and `b` cannot both exist: one is a file where the other needs a directory. */
function conflicts(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function selectInputs(
  found: InputCandidate[],
  missing: MissingRef[],
  params: { code: string; args: string[]; config: Config['exec'] },
): InputSelection {
  const { config } = params;
  const hay = [params.code, ...params.args].join('\n');
  const omitted: OmittedInput[] = [];

  const missingNames = missing.map((ref) => ref.name);
  const requested = referencedNames(hay, [...found.map((c) => c.finalName), ...missingNames]);

  for (const ref of missing) {
    if (requested.has(ref.name)) {
      // The code needs this exact file and it is gone: the run cannot succeed.
      throw new StagedFileMissingError(ref.name);
    }
    omitted.push({ name: ref.name, reason: 'expired' });
  }

  const candidates = supersede(collapseDuplicates(found, requested), omitted);
  const named = referencedNames(hay, [...candidates.map((c) => c.finalName), ...missingNames]);
  const p0 = candidates.filter((c) => named.has(c.finalName));
  const p0Dirs = new Set(p0.map((c) => topDir(c.finalName)).filter((d): d is string => d != null));
  const p1 = candidates.filter((c) => {
    if (p0.includes(c)) {
      return false;
    }
    const dir = topDir(c.finalName);
    return dir != null && (p0Dirs.has(dir) || mentionsDir(hay, dir));
  });
  const rest = optionalOrder(candidates.filter((c) => !p0.includes(c) && !p1.includes(c)));

  if (p0.length > config.inputMaxFiles) {
    throw new ReferencedInputsOverBudgetError(p0.length, config.inputMaxFiles);
  }
  const selected: InputCandidate[] = [];
  let totalBytes = 0;
  let optionalBytes = 0;
  const conflictsWithSelected = (c: InputCandidate) =>
    selected.some((s) => conflicts(s.finalName, c.finalName));

  for (const candidate of p0) {
    if (candidate.doc.size > config.inputMaxFileBytes) {
      throw new ValidationError(
        `input file '${candidate.finalName}' exceeds the maximum size`,
        413,
      );
    }
    if (conflictsWithSelected(candidate)) {
      omitted.push({ name: candidate.finalName, reason: 'path_conflict' });
      continue;
    }
    totalBytes += candidate.doc.size;
    if (totalBytes > config.inputMaxTotalBytes) {
      throw new ValidationError('aggregate input size exceeds the maximum', 413);
    }
    selected.push(candidate);
  }

  const fill = (pool: InputCandidate[], optional: boolean) => {
    for (const candidate of pool) {
      if (conflictsWithSelected(candidate)) {
        omitted.push({ name: candidate.finalName, reason: 'path_conflict' });
        continue;
      }
      if (candidate.doc.size > config.inputMaxFileBytes) {
        omitted.push({ name: candidate.finalName, reason: 'too_large' });
        continue;
      }
      const fits =
        selected.length < config.inputMaxFiles &&
        totalBytes + candidate.doc.size <= config.inputMaxTotalBytes &&
        (!optional || optionalBytes + candidate.doc.size <= config.inputOptionalMaxBytes);
      if (!fits) {
        omitted.push({ name: candidate.finalName, reason: 'budget' });
        continue;
      }
      totalBytes += candidate.doc.size;
      if (optional) {
        optionalBytes += candidate.doc.size;
      }
      selected.push(candidate);
    }
  };
  fill(p1, false);
  const mandatoryCount = selected.length;
  fill(rest, true);

  return { selected, mandatoryCount, omitted };
}

const NOTE_MAX_NAMES = 5;

/**
 * The model-facing line for inputs that were not mounted. Superseded older copies are
 * reported only as a count — the newest version *is* mounted, so naming them would read
 * as a missing file.
 */
export function buildOmittedNote(
  omitted: OmittedInput[],
  params: { available: number; limit: number },
): string | null {
  const list = (reasons: (reason: OmitReason) => boolean) => {
    const names = [...new Set(omitted.filter((o) => reasons(o.reason)).map((o) => o.name))];
    const more = names.length > NOTE_MAX_NAMES ? ` (+${names.length - NOTE_MAX_NAMES} more)` : '';
    return { names, text: `${names.slice(0, NOTE_MAX_NAMES).join(', ')}${more}` };
  };
  const unmounted = list((r) => r !== 'superseded' && r !== 'expired');
  const expired = list((r) => r === 'expired');
  const superseded = omitted.filter((o) => o.reason === 'superseded').length;

  const parts: string[] = [];
  if (unmounted.names.length > 0) {
    parts.push(
      `Note: ${unmounted.names.length} of ${params.available} available files were not ` +
        `mounted in /mnt/data for this run (limit ${params.limit} files): ${unmounted.text}. ` +
        `They still exist — use a file's exact path (e.g. /mnt/data/${unmounted.names[0]}) in ` +
        'the command to have it mounted.',
    );
  }
  if (expired.names.length > 0) {
    parts.push(
      `Note: ${expired.names.length} earlier file(s) have expired and were skipped: ` +
        `${expired.text}. Re-attach any you still need.`,
    );
  }
  // Alone it is noise: the newest copy is mounted, so nothing is missing.
  if (superseded > 0 && parts.length > 0) {
    parts.push(
      `${superseded} older same-name cop${superseded === 1 ? 'y was' : 'ies were'} ` +
        'replaced by the newest version.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
