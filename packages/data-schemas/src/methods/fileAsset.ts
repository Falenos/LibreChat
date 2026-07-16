// [knauf] KK20-195 WP2 — state-machine methods for the FileAsset aggregate.
//
// Every transition is a single-document CAS (`findOneAndUpdate` with the full
// expected-state filter) and claim ownership is fenced by `execution_token`:
// a stale worker's heartbeat/terminal update matches nothing and no-ops. No
// multi-document transactions anywhere (plan invariant #14) — correctness
// comes from these CAS filters, the unique indexes, and reconciliation.
// See knauf/docs/implementation-plans/async-file-indexing-production.md §5.
import crypto from 'node:crypto';
import type { Model, UpdateQuery } from 'mongoose';
import type { IKnaufFileAsset, FileAssetEmbedRoute, FileAssetScopeType } from '~/types';

const ERROR_DETAIL_MAX = 2000;

/** Fields shared by both reservation paths. */
export interface ReserveAssetParams {
  asset_id: string;
  scope_type: FileAssetScopeType;
  scope_id: string;
  target_index_profile: string;
  vector_backend: 'pgvector' | 'azure_search';
  embed_route: FileAssetEmbedRoute;
  content_hash?: string;
  dedup_key?: string;
}

export interface ReserveAssetResult {
  asset: IKnaufFileAsset;
  /** true when THIS call created the asset (caller owns blob upload + queue). */
  created: boolean;
}

export function createFileAssetMethods(mongoose: typeof import('mongoose')): {
  reserveAsset: (params: ReserveAssetParams) => Promise<ReserveAssetResult>;
  markQueued: (params: {
    asset_id: string;
    blob: { source?: string; path?: string; region?: string; bytes?: number; mime?: string };
  }) => Promise<IKnaufFileAsset | null>;
  claimNextDue: (params: {
    workerId: string;
    leaseMs: number;
    now?: Date;
  }) => Promise<IKnaufFileAsset | null>;
  claimAsset: (params: {
    asset_id: string;
    workerId: string;
    leaseMs: number;
    now?: Date;
  }) => Promise<IKnaufFileAsset | null>;
  heartbeatClaim: (params: {
    asset_id: string;
    execution_token: string;
    leaseMs: number;
  }) => Promise<boolean>;
  requeueClaim: (params: {
    asset_id: string;
    execution_token: string;
    next_attempt_at: Date;
    error_code?: string;
  }) => Promise<boolean>;
  failClaim: (params: {
    asset_id: string;
    execution_token: string;
    error_code: string;
    error_detail?: string;
  }) => Promise<boolean>;
  activateGeneration: (params: {
    asset_id: string;
    execution_token: string;
    target_generation: number;
    target_index_profile: string;
  }) => Promise<IKnaufFileAsset | null>;
  retryFailed: (params: { asset_id: string }) => Promise<IKnaufFileAsset | null>;
  tombstoneForDelete: (params: { asset_id: string }) => Promise<IKnaufFileAsset | null>;
  markDeleteFailed: (params: { asset_id: string; error_code: string }) => Promise<boolean>;
  retryDelete: (params: { asset_id: string }) => Promise<boolean>;
  removeAsset: (params: { asset_id: string }) => Promise<boolean>;
  getAssetByAssetId: (asset_id: string) => Promise<IKnaufFileAsset | null>;
  getAssetsByAssetIds: (asset_ids: string[]) => Promise<IKnaufFileAsset[]>;
  countActiveByScope: (params: {
    scope_type: FileAssetScopeType;
    scope_id: string;
  }) => Promise<number>;
  sumActiveBytesByScope: (params: {
    scope_type: FileAssetScopeType;
    scope_id: string;
  }) => Promise<number>;
} {
  const getModel = (): Model<IKnaufFileAsset> =>
    mongoose.models.KnaufFileAsset as Model<IKnaufFileAsset>;

  /** Clear claim ownership atomically with the transition (plan §5.3). */
  const clearLease: UpdateQuery<IKnaufFileAsset>['$unset'] = {
    lease_owner: 1,
    lease_expires_at: 1,
    execution_token: 1,
  };

  /**
   * Atomically find-or-create by dedup_key (chat) or by asset_id (agent /
   * non-deduplicated). Upsert races resolve via the unique index + E11000
   * re-read — the loser reuses the winner's asset (the reservation).
   */
  async function reserveAsset(params: ReserveAssetParams): Promise<ReserveAssetResult> {
    const KnaufFileAsset = getModel();
    const key =
      params.dedup_key != null ? { dedup_key: params.dedup_key } : { asset_id: params.asset_id };
    try {
      // includeResultMetadata: the driver's updatedExisting flag is the only
      // reliable created-vs-found signal (comparing asset_id fails on the
      // asset_id-keyed replay path). Validate on Cosmos/DocumentDB with the
      // ferretdb harness alongside the other claim operators.
      const raw = await KnaufFileAsset.findOneAndUpdate(
        key,
        {
          $setOnInsert: {
            ...params,
            status: 'uploading',
            active_index_profile: null,
            active_generation: null,
            delete_requested_at: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true },
      );
      const asset = (raw.value as IKnaufFileAsset | null)?.toObject?.() ?? raw.value;
      return {
        asset: asset as IKnaufFileAsset,
        created: raw.lastErrorObject?.updatedExisting === false,
      };
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) {
        const winner = await KnaufFileAsset.findOne(key).lean<IKnaufFileAsset>();
        if (winner) {
          return { asset: winner as IKnaufFileAsset, created: false };
        }
      }
      throw error;
    }
  }

  /** CAS uploading → queued once the blob is durably stored. */
  async function markQueued(params: {
    asset_id: string;
    blob: { source?: string; path?: string; region?: string; bytes?: number; mime?: string };
  }): Promise<IKnaufFileAsset | null> {
    const now = new Date();
    return getModel()
      .findOneAndUpdate(
        { asset_id: params.asset_id, status: 'uploading', delete_requested_at: null },
        { $set: { status: 'queued', blob: params.blob, queued_at: now, next_attempt_at: now } },
        { new: true },
      )
      .lean<IKnaufFileAsset>();
  }

  /**
   * The atomic claim (plan §5.1): due queued work OR an expired processing
   * lease, oldest first, tombstones excluded. One findOneAndUpdate = one
   * winner; claim + attempt + generation assignment are never split.
   */
  async function claimNextDue(params: {
    workerId: string;
    leaseMs: number;
    now?: Date;
  }): Promise<IKnaufFileAsset | null> {
    const now = params.now ?? new Date();
    return getModel()
      .findOneAndUpdate(
        {
          delete_requested_at: null,
          $or: [
            { status: 'queued', next_attempt_at: { $lte: now } },
            { status: 'processing', lease_expires_at: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'processing',
            lease_owner: params.workerId,
            lease_expires_at: new Date(now.getTime() + params.leaseMs),
            execution_token: crypto.randomUUID(),
            started_at: now,
          },
          $inc: { attempt_count: 1, target_generation: 1 },
        },
        { sort: { queued_at: 1 }, new: true },
      )
      .lean<IKnaufFileAsset>();
  }

  /**
   * Claim ONE SPECIFIC asset (same CAS semantics as claimNextDue, keyed by
   * asset_id). Used by the synchronous flag-off upload path, which must
   * execute the asset it just queued — never someone else's oldest-due work.
   */
  async function claimAsset(params: {
    asset_id: string;
    workerId: string;
    leaseMs: number;
    now?: Date;
  }): Promise<IKnaufFileAsset | null> {
    const now = params.now ?? new Date();
    return getModel()
      .findOneAndUpdate(
        {
          asset_id: params.asset_id,
          delete_requested_at: null,
          $or: [
            { status: 'queued', next_attempt_at: { $lte: now } },
            { status: 'processing', lease_expires_at: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'processing',
            lease_owner: params.workerId,
            lease_expires_at: new Date(now.getTime() + params.leaseMs),
            execution_token: crypto.randomUUID(),
            started_at: now,
          },
          $inc: { attempt_count: 1, target_generation: 1 },
        },
        { new: true },
      )
      .lean<IKnaufFileAsset>();
  }

  /** Token-fenced lease renewal; a miss means ownership was lost. */
  async function heartbeatClaim(params: {
    asset_id: string;
    execution_token: string;
    leaseMs: number;
  }): Promise<boolean> {
    const result = await getModel().updateOne(
      {
        asset_id: params.asset_id,
        execution_token: params.execution_token,
        status: 'processing',
        delete_requested_at: null,
      },
      { $set: { lease_expires_at: new Date(Date.now() + params.leaseMs) } },
    );
    return result.modifiedCount === 1;
  }

  /** Token-fenced processing → queued (retryable failure); clears the lease. */
  async function requeueClaim(params: {
    asset_id: string;
    execution_token: string;
    next_attempt_at: Date;
    error_code?: string;
  }): Promise<boolean> {
    const $set: UpdateQuery<IKnaufFileAsset>['$set'] = {
      status: 'queued',
      next_attempt_at: params.next_attempt_at,
    };
    if (params.error_code) {
      $set.last_error_code = params.error_code;
    }
    const result = await getModel().updateOne(
      { asset_id: params.asset_id, execution_token: params.execution_token, status: 'processing' },
      { $set, $unset: clearLease },
    );
    return result.modifiedCount === 1;
  }

  /** Token-fenced processing → failed (permanent/exhausted); clears the lease. */
  async function failClaim(params: {
    asset_id: string;
    execution_token: string;
    error_code: string;
    error_detail?: string;
  }): Promise<boolean> {
    const result = await getModel().updateOne(
      { asset_id: params.asset_id, execution_token: params.execution_token, status: 'processing' },
      {
        $set: {
          status: 'failed',
          last_error_code: params.error_code,
          last_error_detail: params.error_detail?.slice(0, ERROR_DETAIL_MAX),
        },
        $unset: clearLease,
      },
    );
    return result.modifiedCount === 1;
  }

  /**
   * The activation CAS (plan §7.4): matches asset + processing + THIS token +
   * THIS generation + no tombstone. A stale/superseded worker matches nothing
   * and must clean only its own generation. Non-pipeline update on purpose —
   * the caller supplies generation/profile from its claim, keeping the write
   * portable across Cosmos/DocumentDB.
   */
  async function activateGeneration(params: {
    asset_id: string;
    execution_token: string;
    target_generation: number;
    target_index_profile: string;
  }): Promise<IKnaufFileAsset | null> {
    return getModel()
      .findOneAndUpdate(
        {
          asset_id: params.asset_id,
          status: 'processing',
          execution_token: params.execution_token,
          target_generation: params.target_generation,
          delete_requested_at: null,
        },
        {
          $set: {
            status: 'ready',
            active_generation: params.target_generation,
            active_index_profile: params.target_index_profile,
            ready_at: new Date(),
            last_error_code: null,
            last_error_detail: null,
          },
          $unset: clearLease,
        },
        { new: true },
      )
      .lean<IKnaufFileAsset>();
  }

  /** Authorized user retry: ONLY failed → queued (plan §6.4); resets attempts. */
  async function retryFailed(params: { asset_id: string }): Promise<IKnaufFileAsset | null> {
    const now = new Date();
    return getModel()
      .findOneAndUpdate(
        { asset_id: params.asset_id, status: 'failed', delete_requested_at: null },
        {
          $set: {
            status: 'queued',
            attempt_count: 0,
            next_attempt_at: now,
            queued_at: now,
            last_error_code: null,
            last_error_detail: null,
          },
        },
        { new: true },
      )
      .lean<IKnaufFileAsset>();
  }

  /**
   * Tombstone + CAS to deleting (last-reference delete). Idempotent: an
   * already-tombstoned asset is returned as-is (concurrent last-reference
   * deletes — one wins the CAS, the other observes the tombstone).
   */
  async function tombstoneForDelete(params: { asset_id: string }): Promise<IKnaufFileAsset | null> {
    const KnaufFileAsset = getModel();
    const updated = await KnaufFileAsset.findOneAndUpdate(
      { asset_id: params.asset_id, delete_requested_at: null },
      { $set: { status: 'deleting', delete_requested_at: new Date() }, $unset: clearLease },
      { new: true },
    ).lean<IKnaufFileAsset>();
    if (updated) {
      return updated as IKnaufFileAsset;
    }
    return KnaufFileAsset.findOne({ asset_id: params.asset_id }).lean<IKnaufFileAsset>();
  }

  /** deleting → delete_failed with a stable code (stays visible + retryable). */
  async function markDeleteFailed(params: {
    asset_id: string;
    error_code: string;
  }): Promise<boolean> {
    const result = await getModel().updateOne(
      { asset_id: params.asset_id, status: 'deleting' },
      { $set: { status: 'delete_failed', last_error_code: params.error_code } },
    );
    return result.modifiedCount === 1;
  }

  /** delete_failed → deleting (operator/automatic retry). */
  async function retryDelete(params: { asset_id: string }): Promise<boolean> {
    const result = await getModel().updateOne(
      { asset_id: params.asset_id, status: 'delete_failed' },
      { $set: { status: 'deleting' } },
    );
    return result.modifiedCount === 1;
  }

  /** Remove the row ONLY after confirmed blob + every-generation cleanup. */
  async function removeAsset(params: { asset_id: string }): Promise<boolean> {
    const result = await getModel().deleteOne({
      asset_id: params.asset_id,
      status: { $in: ['deleting', 'delete_failed'] },
    });
    return result.deletedCount === 1;
  }

  async function getAssetByAssetId(asset_id: string): Promise<IKnaufFileAsset | null> {
    return getModel().findOne({ asset_id }).lean<IKnaufFileAsset>();
  }

  async function getAssetsByAssetIds(asset_ids: string[]): Promise<IKnaufFileAsset[]> {
    if (!asset_ids?.length) {
      return [];
    }
    return getModel()
      .find({ asset_id: { $in: asset_ids } })
      .lean<IKnaufFileAsset[]>();
  }

  /** Admission control (plan §9.3): non-terminal work owned by one scope. */
  async function countActiveByScope(params: {
    scope_type: FileAssetScopeType;
    scope_id: string;
  }): Promise<number> {
    return getModel().countDocuments({
      scope_type: params.scope_type,
      scope_id: params.scope_id,
      status: { $in: ['uploading', 'queued', 'processing'] },
    });
  }

  async function sumActiveBytesByScope(params: {
    scope_type: FileAssetScopeType;
    scope_id: string;
  }): Promise<number> {
    const rows = await getModel().aggregate<{ _id: null; total: number }>([
      {
        $match: {
          scope_type: params.scope_type,
          scope_id: params.scope_id,
          status: { $in: ['uploading', 'queued', 'processing'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$blob.bytes' } } },
    ]);
    return rows[0]?.total ?? 0;
  }

  return {
    reserveAsset,
    markQueued,
    claimNextDue,
    claimAsset,
    heartbeatClaim,
    requeueClaim,
    failClaim,
    activateGeneration,
    retryFailed,
    tombstoneForDelete,
    markDeleteFailed,
    retryDelete,
    removeAsset,
    getAssetByAssetId,
    getAssetsByAssetIds,
    countActiveByScope,
    sumActiveBytesByScope,
  };
}

export type FileAssetMethods = ReturnType<typeof createFileAssetMethods>;
// End [knauf]
