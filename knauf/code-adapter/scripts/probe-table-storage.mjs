#!/usr/bin/env node
/**
 * Phase 0 contract probe for the Mongo -> Table Storage migration (KK20-281,
 * follow-up to KK20-257 finding B2). See
 * `local/KK20-257-code-execution-ownership/security/table-storage-implementation-plan.md`,
 * "Phase 0 — dev platform and contract proof".
 *
 * MUST run as the code-adapter's own workload identity (sa-code-adapter in
 * agentic-karl-dev), not from a laptop, a CI runner identity, or a developer's `az login`
 * session — the entire point is to prove what THAT identity, and only that identity, can
 * and cannot reach. This uses WorkloadIdentityCredential explicitly (not
 * DefaultAzureCredential's fallback chain, which would silently pick up whatever
 * environment/CLI/managed-identity credential happens to be available first and prove
 * nothing about the real identity's scope) and requires the AKS workload-identity webhook's
 * federated-token env vars (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE) to
 * be present; nothing here accepts an account key or connection string.
 *
 *   AZURE_STORAGE_ACCOUNT_NAME=<dev account> node scripts/probe-table-storage.mjs
 *
 * Exits non-zero if any check fails, or if any created entity fails to clean up. Always
 * attempts to delete every entity it creates (best-effort cleanup in a finally block), so
 * re-runs are idempotent and the table is left empty afterwards.
 */
import { createHash, randomUUID } from 'node:crypto';
import { WorkloadIdentityCredential } from '@azure/identity';
import { TableClient, TableServiceClient, RestError } from '@azure/data-tables';

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
if (!ACCOUNT) {
  console.error('AZURE_STORAGE_ACCOUNT_NAME is required (workload-identity auth only).');
  process.exit(2);
}
const REQUIRED_WORKLOAD_IDENTITY_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_FEDERATED_TOKEN_FILE'];
const missingEnv = REQUIRED_WORKLOAD_IDENTITY_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(
    `Missing ${missingEnv.join(', ')} — this probe only proves anything when it runs as the ` +
      'in-cluster workload identity (sa-code-adapter pod, AKS workload-identity webhook). ' +
      'Run it as a Job in agentic-karl-dev, not from a laptop or CI runner.',
  );
  process.exit(2);
}
const ENDPOINT = `https://${ACCOUNT}.table.core.windows.net`;
const TABLE = 'codeAdapterFiles';
// Negative-scope check below also requires codeAdapterProbeControlDev to exist with NO
// role assignment for this identity (agk-infrastructure code-adapter-dev.tf). Unlike the
// original Phase 0 run, this table must now be treated as a DURABLE fixture, not a
// temporary one deleted after a single pass — see the check itself for why.
const credential = new WorkloadIdentityCredential();

let failures = 0;
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}: ${err.message}`);
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const isRestError = (err, statusCode) => err instanceof RestError && err.statusCode === statusCode;

// Probe partition, distinct from any real karl-<32 hex> session id and from the reserved
// __system__ control partition the real repository will use — so this can never collide
// with production data or be mistaken for it.
const PARTITION = `probe-phase0-${randomUUID()}`;
const client = new TableClient(ENDPOINT, TABLE, credential);
const createdRowKeys = [];

async function main() {
  // 0. Role-propagation and retry behavior. A just-applied role assignment can take a
  // little while to become effective; retry the FIRST call with backoff and report how
  // long it actually took, rather than either failing immediately or hiding the delay.
  await check('role propagation (first authorized call succeeds within budget)', async () => {
    const budgetMs = 120_000;
    const startedAt = Date.now();
    let attempt = 0;
    let lastErr;
    while (Date.now() - startedAt < budgetMs) {
      attempt += 1;
      try {
        // A point lookup on a row that does not exist still requires the same
        // authorization as any other data-plane call, and its expected 404 tells us
        // the role is live without needing to create/clean up anything.
        await client.getEntity(PARTITION, 'r:propagation-check');
        lastErr = null;
        break;
      } catch (err) {
        if (isRestError(err, 404)) {
          lastErr = null;
          break;
        }
        lastErr = err;
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
      }
    }
    console.log(`      role became effective after ${attempt} attempt(s), ${Date.now() - startedAt}ms`);
    assert(lastErr == null, `never got past authorization: ${lastErr?.message}`);
  });

  // 1. Create, read, update, delete a single entity.
  await check('create / read / update / delete single entity', async () => {
    const rowKey = 'f:probe-file-1';
    createdRowKeys.push(rowKey);
    await client.createEntity({ partitionKey: PARTITION, rowKey, filename: 'probe.txt', size: 3 });
    const read = await client.getEntity(PARTITION, rowKey);
    assert(read.filename === 'probe.txt', `unexpected filename ${read.filename}`);
    await client.updateEntity(
      { partitionKey: PARTITION, rowKey, size: 4 },
      'Merge',
      { etag: read.etag },
    );
    const updated = await client.getEntity(PARTITION, rowKey);
    assert(updated.size === 4, `update did not stick, size=${updated.size}`);
    await client.deleteEntity(PARTITION, rowKey);
    createdRowKeys.splice(createdRowKeys.indexOf(rowKey), 1);
    let stillThere = true;
    try {
      await client.getEntity(PARTITION, rowKey);
    } catch (err) {
      assert(isRestError(err, 404), `expected 404 after delete, got: ${err.message}`);
      stillThere = false;
    }
    assert(!stillThere, 'entity still readable after delete');
  });

  // 2a. NOTE: Storage Table Data Contributor is NOT data-plane-only — its `actions` include
  // tableServices/tables/{read,write,delete} (control-plane manage/delete), separate from
  // its `dataActions` (entity CRUD). This check does NOT prove the role lacks control-plane
  // capability; it proves the role assignment's SCOPE (the codeAdapterFiles table resource
  // only) blocks a control-plane call against a *different*, not-yet-existing resource. A
  // rogue table under an existing, in-scope name would not be covered by this check.
  await check('identity cannot create a table outside its assigned scope (control-plane)', async () => {
    const serviceClient = new TableServiceClient(ENDPOINT, credential);
    const rogueTable = `probeRogue${Date.now()}`;
    let createError;
    try {
      await serviceClient.createTable(rogueTable);
    } catch (err) {
      createError = err;
    }

    if (createError) {
      assert(
        isRestError(createError, 403) || isRestError(createError, 401),
        `expected 401/403 creating a table, got: ${createError.message}`,
      );
      return;
    }

    // Creation succeeded, so the scope assertion failed. Keep cleanup errors separate:
    // a denied delete must never be mistaken for the expected create denial.
    try {
      await serviceClient.deleteTable(rogueTable);
    } catch (err) {
      throw new Error(
        `createTable unexpectedly SUCCEEDED and cleanup of ${rogueTable} failed: ${err.message}`,
      );
    }
    throw new Error('createTable unexpectedly SUCCEEDED - role scope is too broad');
  });

  // 2b. This identity must NOT be able to reach a DIFFERENT table that genuinely exists on
  // the same account but carries no role assignment for it — a real 403 tied to a resource
  // that actually exists, not merely "table absent" (which would prove nothing about scope).
  // codeAdapterProbeControlDev MUST be a DURABLE fixture (agk-infrastructure
  // code-adapter-dev.tf) for this check to mean anything: Azure's AAD-authorization path can
  // return 403 for a resource that doesn't exist at all (RBAC scope is evaluated without
  // necessarily confirming existence first, so as not to leak which resources exist to an
  // unauthorized caller) — so a bare 403 alone does not, by itself, prove denial against an
  // existing sibling table. Treat a 404 here as the fixture being gone, not as a pass.
  await check('identity gets a real 403 on an ungranted-but-existing control table', async () => {
    const controlClient = new TableClient(ENDPOINT, 'codeAdapterProbeControlDev', credential);
    try {
      await controlClient.getEntity(PARTITION, 'f:anything');
      throw new Error('read against the ungranted control table unexpectedly SUCCEEDED');
    } catch (err) {
      if (isRestError(err, 404)) {
        throw new Error(
          "codeAdapterProbeControlDev does not exist, so this check's premise (an EXISTING, " +
            'ungranted sibling table) is not met and a pass here would prove nothing. Recreate ' +
            'the table in agk-infrastructure (code-adapter-dev.tf) as a DURABLE fixture — do not ' +
            'delete it again after this run — before re-running this probe.',
        );
      }
      assert(
        isRestError(err, 403),
        `expected 403 (out of RBAC scope) on the existing-but-ungranted control table, got: ${err.message}`,
      );
    }
  });

  // 2c. This identity's Table role must not somehow reach the app's OWN Blob container
  // (`files`). It legitimately holds Storage Blob Data Contributor on `code-adapter-staging`
  // already (KK20-257, unrelated to this Table grant) - that access is expected and is not
  // what's under test here. The boundary that matters is the container this identity has
  // NEVER been granted.
  await check('identity cannot read the app-owned Blob container (files)', async () => {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const blobClient = new BlobServiceClient(`https://${ACCOUNT}.blob.core.windows.net`, credential);
    const container = blobClient.getContainerClient('files');
    try {
      const iter = container.listBlobsFlat();
      await iter.next();
      throw new Error('listing the app-owned Blob container unexpectedly SUCCEEDED');
    } catch (err) {
      assert(
        isRestError(err, 403) || isRestError(err, 401),
        `expected 401/403 against the app's files container, got: ${err.message}`,
      );
    }
  });

  // 3. Three-entity same-partition transaction (file + filename-index + blob-index shape).
  await check('three-entity same-partition transaction commits atomically', async () => {
    const fileRow = 'f:probe-file-2';
    const nameRow = `n:${createHash('sha256').update('probe-txn.csv').digest('hex')}`;
    const blobRow = 'b:probe-blob-2';
    createdRowKeys.push(fileRow, nameRow, blobRow);
    await client.submitTransaction([
      ['create', { partitionKey: PARTITION, rowKey: fileRow, filename: 'probe-txn.csv' }],
      ['create', { partitionKey: PARTITION, rowKey: nameRow, fileId: 'probe-file-2' }],
      ['create', { partitionKey: PARTITION, rowKey: blobRow, fileId: 'probe-file-2' }],
    ]);
    for (const rowKey of [fileRow, nameRow, blobRow]) {
      await client.getEntity(PARTITION, rowKey); // throws if any leg didn't land
    }
  });

  // 4. Force a real ETag conflict: read once, update twice from the same starting ETag.
  await check('ETag conflict on a stale conditional update surfaces as 412', async () => {
    const rowKey = 'f:probe-file-3';
    createdRowKeys.push(rowKey);
    await client.createEntity({ partitionKey: PARTITION, rowKey, size: 1 });
    const snapshot = await client.getEntity(PARTITION, rowKey);
    // Winner: succeeds and changes the ETag server-side.
    await client.updateEntity({ partitionKey: PARTITION, rowKey, size: 2 }, 'Replace', {
      etag: snapshot.etag,
    });
    // Loser: still holds the now-stale ETag from the same snapshot.
    try {
      await client.updateEntity({ partitionKey: PARTITION, rowKey, size: 3 }, 'Replace', {
        etag: snapshot.etag,
      });
      throw new Error('stale-ETag update unexpectedly SUCCEEDED');
    } catch (err) {
      assert(isRestError(err, 412), `expected 412 Precondition Failed, got: ${err.message}`);
    }
  });

  // 5. Nested filenames (containing "/") must work via a hashed RowKey, since raw "/" is
  // rejected in RowKey. This is the design's whole reason for n:<sha256(filename)> instead
  // of n:<filename>.
  await check('nested filename resolves through hashed filename-index key', async () => {
    const filename = 'reports/out.csv'; // deliberately contains "/" - would break a raw RowKey
    const nameRow = `n:${createHash('sha256').update(filename).digest('hex')}`;
    createdRowKeys.push(nameRow);
    await client.createEntity({ partitionKey: PARTITION, rowKey: nameRow, filename, fileId: 'probe-nested' });
    const read = await client.getEntity(PARTITION, nameRow);
    assert(read.filename === filename, `filename round-trip mismatch: ${read.filename}`);
  });

  // 6. The proposed readiness check itself: point lookup on a reserved, nonexistent
  // partition/row, expecting 404 - proves table-scoped data access without any
  // service-level (getProperties) permission, which this role does not grant.
  await check('readiness point lookup on reserved nonexistent key returns 404, not 403', async () => {
    try {
      await client.getEntity('__system__', '__readiness__');
      throw new Error('reserved readiness row unexpectedly EXISTS - pick a different key');
    } catch (err) {
      assert(
        isRestError(err, 404),
        `readiness check must see 404 (authorized-but-absent), got: ${err.message} ` +
          '- a 403 here would mean the role grant is missing or misconfigured',
      );
    }
  });
}

main()
  .catch((err) => {
    failures += 1;
    console.error('FAIL  unhandled error in probe:', err);
  })
  .finally(async () => {
    // Best-effort cleanup, but "best-effort" must not mean "unreported": a leftover probe
    // entity is harmless (PARTITION is unique per run), yet the script's own contract above
    // promises the table is left empty afterwards. Track failures separately from check
    // failures so a clean check run with failed cleanup is never reported as an unqualified
    // PASS, and still exits non-zero.
    let cleanupFailures = 0;
    for (const rowKey of createdRowKeys) {
      try {
        await client.deleteEntity(PARTITION, rowKey);
      } catch (err) {
        cleanupFailures += 1;
        console.error(`WARN  cleanup failed for ${PARTITION}/${rowKey}: ${err.message}`);
      }
    }
    console.log(failures === 0 ? '\nAll Phase 0 contract checks PASSED.' : `\n${failures} check(s) FAILED.`);
    if (cleanupFailures > 0) {
      console.error(
        `${cleanupFailures} entit${cleanupFailures === 1 ? 'y' : 'ies'} failed to clean up ` +
          `(partition ${PARTITION}) — table is NOT left empty; delete manually.`,
      );
    }
    process.exit(failures === 0 && cleanupFailures === 0 ? 0 : 1);
  });
