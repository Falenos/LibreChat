// [knauf] KK20-195 WP2 — seam test for the async-indexing additions to the
// File schema: the batch-id field and the owner-scoped batch / asset lookup
// indexes. Fails if the field or either index is dropped or de-scoped.
import fileSchema from './file';

describe('file schema — KK20-195 async-indexing seam', () => {
  test('carries knauf_upload_batch_id', () => {
    expect(fileSchema.path('knauf_upload_batch_id')).toBeDefined();
    expect(fileSchema.path('knauf_upload_finalized')).toBeDefined();
  });

  test('batch lookups are owner-scoped and partial (never a global batch query)', () => {
    const indexes = fileSchema.indexes();
    const batch = indexes.find(
      ([k]) => JSON.stringify(k) === JSON.stringify({ user: 1, knauf_upload_batch_id: 1 }),
    );
    expect(batch).toBeDefined();
    expect(batch?.[1]?.partialFilterExpression).toEqual({
      knauf_upload_batch_id: { $exists: true },
    });
  });

  test('knauf_asset_id has a partial lookup index (refcount + status hydration)', () => {
    const indexes = fileSchema.indexes();
    const asset = indexes.find(
      ([k]) => JSON.stringify(k) === JSON.stringify({ knauf_asset_id: 1 }),
    );
    expect(asset).toBeDefined();
    expect(asset?.[1]?.partialFilterExpression).toEqual({ knauf_asset_id: { $exists: true } });
  });
});
// End [knauf]
