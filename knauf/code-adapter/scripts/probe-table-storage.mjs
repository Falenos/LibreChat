#!/usr/bin/env node
/**
 * Phase 0 contract probe for the Mongo -> Table Storage migration (KK20-281,
 * follow-up to KK20-257 finding B2). See
 * `local/KK20-257-code-execution-ownership/security/table-storage-implementation-plan.md`,
 * "Phase 0 — dev platform and contract proof".
 *
 * MUST run as the code-adapter's own workload identity (sa-code-adapter in
 * agentic-karl-dev), not from a laptop or a CI runner identity — the entire point is to
 * prove what THAT identity can and cannot reach. DefaultAzureCredential picks up the
 * in-cluster federated token automatically; nothing here accepts an account key or
 * connection string.
 *
 *   AZURE_STORAGE_ACCOUNT_NAME=<dev account> node scripts/probe-table-storage.mjs
 *
 * Exits non-zero if any check fails. Always deletes every entity it creates, including
 * on failure (best-effort cleanup in a finally block), so re-runs are idempotent and the
 * table is left empty afterwards.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { TableClient, TableServiceClient, RestError } from '@azure/data-tables';

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
if (!ACCOUNT) {
  console.error('AZURE_STORAGE_ACCOUNT_NAME is required (workload-identity auth only).');
  process.exit(2);
}
const ENDPOINT = `https://${ACCOUNT}.table.core.windows.net`;
const TABLE = 'codeAdapterFiles';
// Negative-scope check below also requires codeAdapterProbeControlDev to exist with NO
// role assignment for this identity (agk-infrastructure code-adapter-dev.tf).
const credential = new DefaultAzureCredential();

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

  // 2a. This identity cannot use control-plane operations, only the data-plane role
  // granted at the table scope. Creating a *new* table is control-plane.
  await check('identity cannot create a new table (control-plane, not granted)', async () => {
    const serviceClient = new TableServiceClient(ENDPOINT, credential);
    const rogueTable = `probeRogue${Date.now()}`;
    try {
      await serviceClient.createTable(rogueTable);
      // If this succeeds, the grant is far broader than intended - clean up and fail loudly.
      await serviceClient.deleteTable(rogueTable);
      throw new Error('createTable unexpectedly SUCCEEDED - role scope is too broad');
    } catch (err) {
      assert(
        isRestError(err, 403) || isRestError(err, 401),
        `expected 401/403 creating a table, got: ${err.message}`,
      );
    }
  });

  // 2b. This identity cannot reach a DIFFERENT table that genuinely exists on the same
  // account but carries no role assignment for it — a real 403, not just "table absent".
  // codeAdapterProbeControlDev is a temporary, deliberately ungranted control table created
  // solely for this check (agk-infrastructure code-adapter-dev.tf); delete it once Phase 0
  // is done.
  await check('identity gets a real 403 on an ungranted-but-existing table', async () => {
    const controlClient = new TableClient(ENDPOINT, 'codeAdapterProbeControlDev', credential);
    try {
      await controlClient.getEntity(PARTITION, 'f:anything');
      throw new Error('read against the ungranted control table unexpectedly SUCCEEDED');
    } catch (err) {
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
    for (const rowKey of createdRowKeys) {
      try {
        await client.deleteEntity(PARTITION, rowKey);
      } catch {
        // best-effort cleanup; a leftover probe entity is harmless and only affects PARTITION
      }
    }
    console.log(failures === 0 ? '\nAll Phase 0 contract checks PASSED.' : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
