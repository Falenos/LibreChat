import { randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import type { TokenCredential } from '@azure/identity';
import type { Config } from '../config.js';
import type { Metrics } from '../middleware/metrics.js';

export type TableEntityRecord = Record<string, unknown> & {
  partitionKey: string;
  rowKey: string;
  etag?: string;
};

export type StoredTableEntity = TableEntityRecord & { etag: string };

export type TableMutation =
  | { type: 'create'; entity: TableEntityRecord }
  | {
      type: 'update';
      entity: TableEntityRecord;
      etag: string;
      mode?: 'Merge' | 'Replace';
    }
  | { type: 'delete'; partitionKey: string; rowKey: string; etag: string };

export interface TableListRequest {
  partitionKey?: string;
  rowKey?: string;
  rowKeyLower?: string;
  rowKeyUpper?: string;
  continuationToken?: string;
  maxPageSize: number;
}

export interface TablePage {
  entities: StoredTableEntity[];
  continuationToken: string | null;
}

export interface RepositoryTableClient {
  get(
    partitionKey: string,
    rowKey: string,
    signal?: AbortSignal,
  ): Promise<StoredTableEntity | null>;
  submitTransaction(actions: TableMutation[], signal?: AbortSignal): Promise<void>;
  listPage(request: TableListRequest, signal?: AbortSignal): Promise<TablePage>;
  checkTransactionSupport?(): Promise<void>;
}

export function storageStatus(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error != null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return null;
}

function storageCode(error: unknown): string | null {
  if (typeof error !== 'object' || error == null) {
    return null;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (
    'details' in error &&
    typeof error.details === 'object' &&
    error.details != null &&
    'odataError' in error.details &&
    typeof error.details.odataError === 'object' &&
    error.details.odataError != null &&
    'code' in error.details.odataError &&
    typeof error.details.odataError.code === 'string'
  ) {
    return error.details.odataError.code;
  }
  return null;
}

export function isEntityNotFound(error: unknown): boolean {
  const code = storageCode(error);
  return storageStatus(error) === 404 && (code === 'EntityNotFound' || code === 'ResourceNotFound');
}

export function isTableConflict(error: unknown): boolean {
  const status = storageStatus(error);
  return status === 409 || status === 412;
}

function escapeOData(value: string): string {
  return value.replaceAll("'", "''");
}

function operationOutcome(error: unknown): 'not_found' | 'conflict' | 'error' {
  if (isEntityNotFound(error)) {
    return 'not_found';
  }
  if (isTableConflict(error)) {
    return 'conflict';
  }
  return 'error';
}

interface RuntimeTableClient {
  url: string;
  tableName: string;
  generatedClient: unknown;
  credential?: unknown;
  allowInsecureConnection?: boolean;
}

interface ConditionalTransaction {
  createEntity(entity: TableEntityRecord): void;
  updateEntity(
    entity: TableEntityRecord,
    mode: 'Merge' | 'Replace',
    options: { etag: string },
  ): void;
  deleteEntity(partitionKey: string, rowKey: string, options: { etag: string }): void;
  submitTransaction(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

type ConditionalTransactionConstructor = new (
  url: string,
  partitionKey: string,
  transactionId: string,
  changesetId: string,
  client: unknown,
  interceptClient: TableClient,
  credential?: unknown,
  allowInsecureConnection?: boolean,
) => ConditionalTransaction;

let conditionalTransactionConstructor: Promise<ConditionalTransactionConstructor> | null = null;

async function loadConditionalTransactionConstructor(): Promise<ConditionalTransactionConstructor> {
  conditionalTransactionConstructor ??= (async () => {
    // @azure/data-tables 13.3.2 exposes conditional deletes in its transaction
    // implementation but omits them from TableClient.submitTransaction's public tuple.
    const sdkEntry = import.meta.resolve('@azure/data-tables');
    const sdkTransaction = new URL('./TableTransaction.js', sdkEntry);
    const module = (await import(sdkTransaction.href)) as {
      InternalTableTransaction: ConditionalTransactionConstructor;
    };
    return module.InternalTableTransaction;
  })();
  return conditionalTransactionConstructor;
}

class AzureRepositoryTableClient implements RepositoryTableClient {
  constructor(
    private readonly client: TableClient,
    private readonly metrics?: Metrics,
  ) {}

  private runtimeClient(): RuntimeTableClient {
    const runtime = this.client as unknown as Partial<RuntimeTableClient>;
    if (
      typeof runtime.url !== 'string' ||
      runtime.url === '' ||
      typeof runtime.tableName !== 'string' ||
      runtime.tableName === '' ||
      runtime.generatedClient == null
    ) {
      throw new Error(
        '@azure/data-tables runtime shape is incompatible with conditional transactions',
      );
    }
    return runtime as RuntimeTableClient;
  }

  async checkTransactionSupport(): Promise<void> {
    this.runtimeClient();
    const Transaction = await loadConditionalTransactionConstructor();
    if (typeof Transaction !== 'function') {
      throw new Error('@azure/data-tables conditional transaction implementation is unavailable');
    }
  }

  private async measured<T>(
    op: 'get' | 'transaction' | 'list',
    work: () => Promise<T>,
  ): Promise<T> {
    const stop = this.metrics?.tableOperationDuration.startTimer({ op });
    try {
      const result = await work();
      stop?.({ outcome: 'success' });
      return result;
    } catch (error) {
      const outcome = operationOutcome(error);
      stop?.({ outcome });
      const status = storageStatus(error);
      if (status === 409 || status === 412) {
        this.metrics?.tableConflicts.inc({ op, status: String(status) });
      }
      throw error;
    }
  }

  async get(
    partitionKey: string,
    rowKey: string,
    signal?: AbortSignal,
  ): Promise<StoredTableEntity | null> {
    try {
      return await this.measured('get', async () => {
        const entity = await this.client.getEntity<Record<string, unknown>>(
          partitionKey,
          rowKey,
          signal != null ? { abortSignal: signal } : {},
        );
        return entity as StoredTableEntity;
      });
    } catch (error) {
      if (isEntityNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async submitTransaction(actions: TableMutation[], signal?: AbortSignal): Promise<void> {
    if (actions.length === 0) {
      return;
    }
    signal?.throwIfAborted();
    await this.measured('transaction', async () => {
      const partitionKey =
        actions[0]?.type === 'delete'
          ? actions[0].partitionKey
          : (actions[0]?.entity.partitionKey ?? '');
      const runtime = this.runtimeClient();
      const Transaction = await loadConditionalTransactionConstructor();
      const interceptClient = new TableClient(runtime.url, runtime.tableName, {
        allowInsecureConnection: runtime.allowInsecureConnection ?? false,
      });
      const transaction = new Transaction(
        runtime.url,
        partitionKey,
        randomUUID(),
        randomUUID(),
        runtime.generatedClient,
        interceptClient,
        runtime.credential,
        runtime.allowInsecureConnection,
      );
      for (const action of actions) {
        if (action.type === 'create') {
          transaction.createEntity(action.entity);
        } else if (action.type === 'update') {
          transaction.updateEntity(action.entity, action.mode ?? 'Replace', { etag: action.etag });
        } else {
          transaction.deleteEntity(action.partitionKey, action.rowKey, { etag: action.etag });
        }
      }
      await transaction.submitTransaction(signal != null ? { abortSignal: signal } : {});
      signal?.throwIfAborted();
    });
  }

  async listPage(request: TableListRequest, signal?: AbortSignal): Promise<TablePage> {
    return this.measured('list', async () => {
      const filters: string[] = [];
      if (request.partitionKey != null) {
        filters.push(`PartitionKey eq '${escapeOData(request.partitionKey)}'`);
      }
      if (request.rowKey != null) {
        filters.push(`RowKey eq '${escapeOData(request.rowKey)}'`);
      }
      if (request.rowKeyLower != null) {
        filters.push(`RowKey ge '${escapeOData(request.rowKeyLower)}'`);
      }
      if (request.rowKeyUpper != null) {
        filters.push(`RowKey lt '${escapeOData(request.rowKeyUpper)}'`);
      }
      const queryOptions = filters.length > 0 ? { filter: filters.join(' and ') } : undefined;
      const pages = this.client
        .listEntities<Record<string, unknown>>({
          ...(queryOptions != null ? { queryOptions } : {}),
          ...(signal != null ? { abortSignal: signal } : {}),
        })
        .byPage({
          ...(request.continuationToken != null
            ? { continuationToken: request.continuationToken }
            : {}),
          maxPageSize: request.maxPageSize,
        });
      const page = await pages.next();
      if (page.done) {
        return { entities: [], continuationToken: null };
      }
      return {
        entities: page.value as StoredTableEntity[],
        continuationToken: page.value.continuationToken ?? null,
      };
    });
  }
}

export function createTableStore(
  config: Config,
  credential: TokenCredential,
  metrics?: Metrics,
): RepositoryTableClient {
  let client: TableClient;
  if (config.table.localConnectionString != null) {
    if (!config.localMode) {
      throw new Error('Table connection-string auth is local-mode-only');
    }
    client = TableClient.fromConnectionString(
      config.table.localConnectionString,
      config.table.tableName,
    );
  } else {
    if (config.table.accountUrl == null) {
      throw new Error('Table workload-identity auth requires an account URL');
    }
    client = new TableClient(config.table.accountUrl, config.table.tableName, credential);
  }
  return new AzureRepositoryTableClient(client, metrics);
}

export async function checkTableReadiness(
  table: RepositoryTableClient,
  metrics?: Metrics,
  signal?: AbortSignal,
): Promise<void> {
  let page;
  try {
    await table.checkTransactionSupport?.();
    const request = {
      partitionKey: '__system__',
      rowKey: '__readiness__',
      maxPageSize: 1,
    };
    page = signal == null ? await table.listPage(request) : await table.listPage(request, signal);
  } catch (error) {
    metrics?.metadataReadiness.inc({ outcome: 'error' });
    throw error;
  }
  if (page.entities.length > 0) {
    metrics?.metadataReadiness.inc({ outcome: 'unexpected_entity' });
    throw new Error('reserved Table readiness entity exists');
  }
  metrics?.metadataReadiness.inc({ outcome: 'ready' });
}
