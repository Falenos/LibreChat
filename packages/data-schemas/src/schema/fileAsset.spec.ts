// [knauf] KK20-195 WP2 — seam test for the FileAsset schema: the plan-§4.2
// field contract and the plan-§4.3 index set. Fails if a field, enum value,
// default, or required index is dropped or renamed.
import fileAssetSchema from './fileAsset';

describe('fileAssetSchema (KK20-195 WP2)', () => {
  const path = (name: string) => fileAssetSchema.path(name);

  test('targets the knauf_file_assets collection', () => {
    expect(fileAssetSchema.get('collection')).toBe('knauf_file_assets');
  });

  test('carries the plan-§4.2 field set', () => {
    const required = [
      'asset_id',
      'scope_type',
      'scope_id',
      'content_hash',
      'dedup_key',
      'target_index_profile',
      'active_index_profile',
      'vector_backend',
      'embed_route',
      'status',
      'attempt_count',
      'next_attempt_at',
      'lease_owner',
      'lease_expires_at',
      'execution_token',
      'target_generation',
      'active_generation',
      'last_error_code',
      'last_error_detail',
      'queued_at',
      'started_at',
      'ready_at',
      'delete_requested_at',
    ];
    for (const field of required) {
      expect(path(field)).toBeDefined();
    }
    // Blob is a stable-key subdocument — never an expiring SAS URL field.
    expect(path('blob.source')).toBeDefined();
    expect(path('blob.path')).toBeDefined();
    expect(path('blob.bytes')).toBeDefined();
    expect(path('blob.filename')).toBeDefined();
  });

  test('status covers all seven plan-§5 states and defaults to uploading', () => {
    const status = path('status') as unknown as {
      enumValues: string[];
      defaultValue: string;
    };
    expect(status.enumValues).toEqual([
      'uploading',
      'queued',
      'processing',
      'ready',
      'failed',
      'deleting',
      'delete_failed',
    ]);
    expect(status.defaultValue).toBe('uploading');
  });

  test('vector backend and embed route are closed enums', () => {
    expect((path('vector_backend') as unknown as { enumValues: string[] }).enumValues).toEqual([
      'pgvector',
      'azure_search',
    ]);
    expect((path('embed_route') as unknown as { enumValues: string[] }).enumValues).toEqual([
      '/embed',
      '/agent/embed',
    ]);
  });

  test('declares the plan-§4.3 index set', () => {
    const indexes = fileAssetSchema.indexes();
    const find = (keys: Record<string, number>) =>
      indexes.find(([k]) => JSON.stringify(k) === JSON.stringify(keys));

    // asset_id unique (field-level).
    const assetId = find({ asset_id: 1 });
    expect(assetId?.[1]?.unique).toBe(true);

    // Tenant-scoped dedup uniqueness (KK20-195 review R1): dedup keys never
    // coalesce across tenants; partial so agent-library assets stay out.
    const dedup = find({ tenantId: 1, dedup_key: 1 });
    expect(dedup?.[1]?.unique).toBe(true);
    expect(dedup?.[1]?.partialFilterExpression).toEqual({ dedup_key: { $exists: true } });

    // Claim, stale-claim, deletion-reconciliation, operational indexes.
    expect(find({ status: 1, next_attempt_at: 1, queued_at: 1 })).toBeDefined();
    expect(find({ status: 1, lease_expires_at: 1 })).toBeDefined();
    expect(find({ delete_requested_at: 1, status: 1 })).toBeDefined();
    expect(find({ updatedAt: 1, status: 1 })).toBeDefined();

    // KK20-195 review — admission counters + reconciler invariant sweeps.
    expect(find({ scope_type: 1, scope_id: 1, status: 1 })).toBeDefined();
    expect(find({ status: 1, active_generation: 1 })).toBeDefined();
    expect(find({ status: 1, last_error_code: 1 })).toBeDefined();
  });

  test('attempt/generation counters default safely', () => {
    expect((path('attempt_count') as unknown as { defaultValue: number }).defaultValue).toBe(0);
    expect((path('target_generation') as unknown as { defaultValue: number }).defaultValue).toBe(0);
  });
});
// End [knauf]
