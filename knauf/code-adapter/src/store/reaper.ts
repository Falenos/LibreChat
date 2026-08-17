import { isValidFileId, isValidSessionId } from '../validate.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FilesRepo } from './filesRepo.js';
import type { Logger } from '../logger.js';

/**
 * [knauf] KK20-257 review finding A1 — delete staged bytes once nothing can reach them.
 *
 * THE LEAK. Mongo is the source of truth for a staged file: the row holds its blob path,
 * its owner, and its expiry. The TTL index deletes that row 24h after last use — and with
 * it the only pointer to the blob and the only record of whose data it is. The bytes stayed
 * in the storage account indefinitely, unreferenced and unattributable. The blobStore
 * docblock claimed a container lifecycle rule handled this; none exists (agk-infrastructure
 * #73 defers it), so nothing did.
 *
 * WHY NOT AN AGE RULE. The obvious fix — a Terraform management policy deleting blobs older
 * than N days — is wrong here, and quietly so. `FilesRepo.touch` *slides* `expiresAt` on
 * every exec push and every download, so a file in active use across a long conversation
 * keeps a valid row while its blob's `createdOn` recedes. An age-only rule would delete
 * blobs that are still referenced, and the failure surfaces as "the file expired" on a file
 * the user just used. Reachability is the only correct test, and only the adapter can
 * evaluate it.
 *
 * Age is still used, but only as a cheap pre-filter: a blob younger than the TTL cannot yet
 * be orphaned, so it is skipped without a Mongo round trip. That also avoids racing an
 * upload — staged uploads write the row before the blob, while captures stream to a unique
 * blob before committing that exact path to Mongo. A blob whose commit is mid-flight must
 * not be swept.
 *
 * Safe to run on every replica: deletes are keyed on a specific path and go through
 * `deleteIfExists`, so two reapers racing the same orphan is a no-op, not an error.
 */
export interface Reaper {
  /** One pass. Exposed for tests and for a manual sweep. */
  runOnce(): Promise<{ scanned: number; deleted: number; skipped: number }>;
  stop(): void;
}

export interface ReaperDeps {
  blob: BlobStore;
  repo: FilesRepo;
  logger: Logger;
  /** Blobs younger than this cannot be orphans yet. Mirrors the Mongo TTL. */
  ttlHours: number;
  intervalMs: number;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => number;
}

/** `<sessionId>/<uuid>` — anything else was not written by this adapter. */
function parseBlobPath(name: string): { sessionId: string; blobId: string } | null {
  const slash = name.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  const sessionId = name.slice(0, slash);
  const blobId = name.slice(slash + 1);
  if (!isValidSessionId(sessionId) || !isValidFileId(blobId)) {
    return null;
  }
  return { sessionId, blobId };
}

export function createReaper(deps: ReaperDeps): Reaper {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const runOnce = async () => {
    let scanned = 0;
    let deleted = 0;
    let skipped = 0;
    // Grace above the TTL so a sliding row always wins a race with the sweep.
    const minAgeMs = deps.ttlHours * 3_600_000 + 3_600_000;

    for await (const blob of deps.blob.list()) {
      scanned += 1;
      const createdOn = blob.createdOn;
      if (createdOn != null && now() - createdOn.getTime() < minAgeMs) {
        skipped += 1;
        continue;
      }
      const parsed = parseBlobPath(blob.name);
      if (parsed == null) {
        // Not ours. Leave it alone rather than guess — this container is dedicated, but
        // deleting an unrecognised path is not a call this process gets to make.
        deps.logger.warn({ blob: blob.name }, 'reaper skipped an unrecognised blob path');
        skipped += 1;
        continue;
      }
      const doc = await deps.repo.findByBlobPath(blob.name);
      if (doc != null) {
        skipped += 1;
        continue;
      }
      try {
        await deps.blob.delete(blob.name);
        deleted += 1;
      } catch (err) {
        // A failed delete is retried on the next pass; the sweep must not abort partway.
        deps.logger.warn({ blob: blob.name, err: (err as Error).message }, 'reaper delete failed');
      }
    }

    return { scanned, deleted, skipped };
  };

  const tick = async () => {
    // Overlap guard: a pass over a large container can outlive the interval.
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runOnce();
      if (result.deleted > 0) {
        deps.logger.info(result, 'reaper deleted orphaned staged blobs');
      } else {
        deps.logger.debug(result, 'reaper pass complete');
      }
    } catch (err) {
      // Never let a sweep failure reach the process — see routes/download.ts for why an
      // unhandled rejection here would be fatal.
      deps.logger.warn({ err: (err as Error).message }, 'reaper pass failed');
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), deps.intervalMs);
  // Must not hold the event loop open: shutdown drains in-flight requests and exits, and a
  // pending sweep is not a reason to stay alive.
  timer.unref();

  return {
    runOnce,
    stop: () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
