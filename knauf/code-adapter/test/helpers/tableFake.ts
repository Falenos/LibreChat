import type {
  RepositoryTableClient,
  StoredTableEntity,
  TableEntityRecord,
  TableListRequest,
  TableMutation,
  TablePage,
} from '../../src/store/tableStore.js';

export class FakeTableError extends Error {
  readonly code: string | undefined;

  constructor(
    public readonly statusCode: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = 'FakeTableError';
    this.code = code ?? (statusCode === 404 ? 'EntityNotFound' : undefined);
  }
}

function cloneEntity<T extends TableEntityRecord>(entity: T): T {
  return structuredClone(entity);
}

function entityKey(partitionKey: string, rowKey: string): string {
  return `${partitionKey}\u0000${rowKey}`;
}

function mutationKey(action: TableMutation): string {
  return action.type === 'delete'
    ? entityKey(action.partitionKey, action.rowKey)
    : entityKey(action.entity.partitionKey, action.entity.rowKey);
}

function mutationPartition(action: TableMutation): string {
  return action.type === 'delete' ? action.partitionKey : action.entity.partitionKey;
}

export class InMemoryTableClient implements RepositoryTableClient {
  private entities = new Map<string, StoredTableEntity>();
  private etagSequence = 0;
  private transactionFailures: number[] = [];
  private listFailures: number[] = [];

  beforeTransaction:
    | ((actions: readonly TableMutation[], table: InMemoryTableClient) => void | Promise<void>)
    | null = null;

  readonly transactions: TableMutation[][] = [];

  private nextEtag(): string {
    this.etagSequence += 1;
    return `"fake-${this.etagSequence}"`;
  }

  seed(entity: TableEntityRecord): StoredTableEntity {
    const key = entityKey(entity.partitionKey, entity.rowKey);
    if (this.entities.has(key)) {
      throw new FakeTableError(409, 'entity already exists');
    }
    const stored = { ...cloneEntity(entity), etag: this.nextEtag() };
    this.entities.set(key, stored);
    return cloneEntity(stored);
  }

  replaceDirect(entity: TableEntityRecord): StoredTableEntity {
    const stored = { ...cloneEntity(entity), etag: this.nextEtag() };
    this.entities.set(entityKey(entity.partitionKey, entity.rowKey), stored);
    return cloneEntity(stored);
  }

  deleteDirect(partitionKey: string, rowKey: string): void {
    this.entities.delete(entityKey(partitionKey, rowKey));
  }

  allEntities(): StoredTableEntity[] {
    return [...this.entities.values()].map((entity) => cloneEntity(entity));
  }

  failNextTransaction(statusCode: 409 | 412 | 503): void {
    this.transactionFailures.push(statusCode);
  }

  failNextList(statusCode: 400 | 503): void {
    this.listFailures.push(statusCode);
  }

  async get(partitionKey: string, rowKey: string): Promise<StoredTableEntity | null> {
    const entity = this.entities.get(entityKey(partitionKey, rowKey));
    return entity == null ? null : cloneEntity(entity);
  }

  async submitTransaction(actions: TableMutation[]): Promise<void> {
    if (actions.length === 0) {
      return;
    }
    if (actions.length > 100) {
      throw new FakeTableError(400, 'transaction exceeds 100 actions');
    }
    const partitions = new Set(actions.map(mutationPartition));
    if (partitions.size !== 1) {
      throw new FakeTableError(400, 'transaction actions must share one partition');
    }
    const keys = actions.map(mutationKey);
    if (new Set(keys).size !== keys.length) {
      throw new FakeTableError(400, 'transaction contains duplicate entity actions');
    }

    const failure = this.transactionFailures.shift();
    if (failure != null) {
      throw new FakeTableError(failure, `injected transaction ${failure}`);
    }
    if (this.beforeTransaction != null) {
      const hook = this.beforeTransaction;
      this.beforeTransaction = null;
      await hook(actions, this);
    }

    const next = new Map(
      [...this.entities.entries()].map(([key, entity]) => [key, cloneEntity(entity)]),
    );
    for (const action of actions) {
      const key = mutationKey(action);
      const existing = next.get(key);
      if (action.type === 'create') {
        if (existing != null) {
          throw new FakeTableError(409, 'entity already exists');
        }
        next.set(key, { ...cloneEntity(action.entity), etag: this.nextEtag() });
        continue;
      }
      if (existing == null) {
        throw new FakeTableError(404, 'entity does not exist');
      }
      if (existing.etag !== action.etag) {
        throw new FakeTableError(412, 'etag condition failed');
      }
      if (action.type === 'delete') {
        next.delete(key);
        continue;
      }
      const replacement =
        action.mode === 'Merge'
          ? { ...existing, ...cloneEntity(action.entity) }
          : cloneEntity(action.entity);
      next.set(key, { ...replacement, etag: this.nextEtag() });
    }

    this.entities = next;
    this.transactions.push(structuredClone(actions));
  }

  async listPage(request: TableListRequest): Promise<TablePage> {
    const failure = this.listFailures.shift();
    if (failure != null) {
      throw new FakeTableError(failure, `injected list ${failure}`);
    }
    let afterKey: string | null = null;
    if (request.continuationToken != null) {
      const match = /^after:([A-Za-z0-9_-]+)$/.exec(request.continuationToken);
      if (match == null) {
        throw new FakeTableError(400, 'invalid continuation token');
      }
      afterKey = Buffer.from(match[1], 'base64url').toString('utf8');
    }
    const filtered = this.allEntities()
      .filter(
        (entity) =>
          (request.partitionKey == null || entity.partitionKey === request.partitionKey) &&
          (request.rowKey == null || entity.rowKey === request.rowKey) &&
          (request.rowKeyLower == null || entity.rowKey >= request.rowKeyLower) &&
          (request.rowKeyUpper == null || entity.rowKey < request.rowKeyUpper),
      )
      .sort(
        (a, b) =>
          a.partitionKey.localeCompare(b.partitionKey) || a.rowKey.localeCompare(b.rowKey),
      );
    const remaining =
      afterKey == null
        ? filtered
        : filtered.filter(
            (entity) => entityKey(entity.partitionKey, entity.rowKey).localeCompare(afterKey) > 0,
          );
    const entities = remaining.slice(0, request.maxPageSize);
    const last = entities.at(-1);
    return {
      entities,
      continuationToken:
        entities.length < remaining.length && last != null
          ? `after:${Buffer.from(entityKey(last.partitionKey, last.rowKey)).toString('base64url')}`
          : null,
    };
  }
}
