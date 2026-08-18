import { DefaultAzureCredential } from '@azure/identity';
import { MongoClient } from 'mongodb';
import { createBlobStore } from '../azure/blobStore.js';
import { loadConfig } from '../config.js';
import { createMetrics } from '../middleware/metrics.js';
import { FilesRepo } from '../store/filesRepo.js';
import { checkTableReadiness, createTableStore } from '../store/tableStore.js';
import { parseLegacyFileDoc } from './legacyFile.js';

interface MigrationSummary {
  apply: boolean;
  source: number;
  migrated: number;
  existing: number;
  validated: number;
  expired: number;
  invalid: number;
  missingBlob: number;
  sizeMismatch: number;
  failed: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value == null || value === '') {
    throw new Error(`${name} is required for Mongo-to-Table migration`);
  }
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apply = process.env.MIGRATION_APPLY === 'true';
  const mongoUri = requiredEnv('MONGO_URI');
  const mongoDb = process.env.MONGO_DB?.trim() || null;
  const collectionName = process.env.MONGO_FILES_COLLECTION?.trim() || 'code_adapter_files';
  const maxDocuments = positiveIntEnv('MIGRATION_MAX_DOCUMENTS', 100_000);
  const batchSize = positiveIntEnv('MIGRATION_BATCH_SIZE', 100);
  const credential = new DefaultAzureCredential();
  const metrics = createMetrics();
  const table = createTableStore(config, credential, metrics);
  await checkTableReadiness(table, metrics);
  const repo = new FilesRepo(table, config.fileTtlHours, metrics);
  const blob = await createBlobStore(config, credential);
  const mongo = new MongoClient(mongoUri);
  const summary: MigrationSummary = {
    apply,
    source: 0,
    migrated: 0,
    existing: 0,
    validated: 0,
    expired: 0,
    invalid: 0,
    missingBlob: 0,
    sizeMismatch: 0,
    failed: 0,
  };

  try {
    await mongo.connect();
    const collection = (mongoDb != null ? mongo.db(mongoDb) : mongo.db()).collection(
      collectionName,
    );
    summary.source = await collection.countDocuments({});
    if (summary.source > maxDocuments) {
      throw new Error(
        `migration source has ${summary.source} documents, above MIGRATION_MAX_DOCUMENTS=${maxDocuments}`,
      );
    }

    const cursor = collection.find({}).sort({ _id: 1 }).batchSize(batchSize);
    for await (const raw of cursor) {
      let doc;
      try {
        doc = parseLegacyFileDoc(raw);
      } catch {
        summary.invalid += 1;
        continue;
      }
      if (doc.expiresAt.getTime() <= Date.now()) {
        summary.expired += 1;
        continue;
      }

      let properties;
      try {
        properties = await blob.head(doc.blobPath);
      } catch {
        summary.failed += 1;
        continue;
      }
      if (properties == null) {
        summary.missingBlob += 1;
        continue;
      }
      if (properties.contentLength !== doc.size) {
        summary.sizeMismatch += 1;
        continue;
      }
      if (!apply) {
        try {
          const target = await repo.checkImportFile(doc);
          if (target === 'existing') {
            summary.existing += 1;
          } else {
            summary.validated += 1;
          }
        } catch {
          summary.failed += 1;
        }
        continue;
      }
      try {
        const result = await repo.importFile(doc);
        if (result === 'created') {
          summary.migrated += 1;
        } else {
          summary.existing += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  } finally {
    await mongo.close();
  }

  console.log(JSON.stringify(summary));
  if (
    summary.invalid > 0 ||
    summary.missingBlob > 0 ||
    summary.sizeMismatch > 0 ||
    summary.failed > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown migration failure';
  console.error(`Mongo-to-Table migration failed: ${message}`);
  process.exitCode = 1;
});
