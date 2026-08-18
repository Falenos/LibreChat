import { describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../helpers/tableFake.js';

describe('InMemoryTableClient transaction semantics', () => {
  it('enforces same-partition and duplicate-action constraints atomically', async () => {
    const table = new InMemoryTableClient();
    await expect(
      table.submitTransaction([
        { type: 'create', entity: { partitionKey: 'a', rowKey: '1' } },
        { type: 'create', entity: { partitionKey: 'b', rowKey: '2' } },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      table.submitTransaction([
        { type: 'create', entity: { partitionKey: 'a', rowKey: '1' } },
        { type: 'delete', partitionKey: 'a', rowKey: '1', etag: '*' },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(table.allEntities()).toHaveLength(0);
  });

  it('enforces entity existence, create conflicts, ETags, and rollback', async () => {
    const table = new InMemoryTableClient();
    const seeded = table.seed({ partitionKey: 'a', rowKey: '1', value: 'old' });

    await expect(
      table.submitTransaction([
        { type: 'create', entity: { partitionKey: 'a', rowKey: '1' } },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      table.submitTransaction([
        {
          type: 'update',
          entity: { partitionKey: 'a', rowKey: '1', value: 'new' },
          etag: '"stale"',
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 412 });
    await expect(
      table.submitTransaction([
        {
          type: 'update',
          entity: { partitionKey: 'a', rowKey: '1', value: 'new' },
          etag: seeded.etag,
        },
        { type: 'delete', partitionKey: 'a', rowKey: 'missing', etag: '*' },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(table.get('a', '1')).resolves.toMatchObject({ value: 'old' });
  });
});
