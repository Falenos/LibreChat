import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';
import type { Config } from '../config.js';
import type { FileDoc } from './filesRepo.js';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  files: Collection<FileDoc>;
  close(): Promise<void>;
}

/**
 * Connect + bootstrap indexes. Index set:
 *  - {sessionId, fileId} unique      — primary lookup key
 *  - {sessionId, filename} unique    — capture upsert key (stable fileIds on re-run)
 *  - {expiresAt} TTL(0)              — 24h expiry, bumped on touch
 */
export async function connectMongo(config: Config): Promise<MongoHandle> {
  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  const db = config.mongo.db != null ? client.db(config.mongo.db) : client.db();
  const files = db.collection<FileDoc>(config.mongo.filesCollection);

  await files.createIndexes([
    { key: { sessionId: 1, fileId: 1 }, unique: true, name: 'session_file_unique' },
    { key: { sessionId: 1, filename: 1 }, unique: true, name: 'session_filename_unique' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expiresAt' },
  ]);

  return {
    client,
    db,
    files,
    close: () => client.close(),
  };
}
