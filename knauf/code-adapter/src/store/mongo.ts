import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';
import type { FileDoc } from './filesRepo.js';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  files: Collection<FileDoc>;
  close(): Promise<void>;
}

export interface MongoMigrationConfig {
  uri: string;
  db: string | null;
  filesCollection: string;
}

/**
 * Migration/cutover helper only. Normal runtime never imports this module or reads MONGO_*.
 * The dependency and source stay available for the later one-off migration tool.
 *
 * Connect + bootstrap the legacy indexes:
 *  - {sessionId, fileId} unique      — primary lookup key
 *  - {sessionId, filename} unique    — capture upsert key (stable fileIds on re-run)
 *  - {blobPath} unique               — exact reachability lookup for the Blob reaper
 *  - {expiresAt} TTL(0)              — 24h expiry, bumped on touch
 */
export async function connectMongo(config: MongoMigrationConfig): Promise<MongoHandle> {
  const client = new MongoClient(config.uri);
  await client.connect();
  const db = config.db != null ? client.db(config.db) : client.db();
  const files = db.collection<FileDoc>(config.filesCollection);

  await files.createIndexes([
    { key: { sessionId: 1, fileId: 1 }, unique: true, name: 'session_file_unique' },
    { key: { sessionId: 1, filename: 1 }, unique: true, name: 'session_filename_unique' },
    { key: { blobPath: 1 }, unique: true, name: 'blob_path_unique' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expiresAt' },
  ]);

  return {
    client,
    db,
    files,
    close: () => client.close(),
  };
}
