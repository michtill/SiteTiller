import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { validateStructure, planStructure } from '../server/structure.ts';
test('ST-05: checkbox defaults, schema and persisted yes/no values', async () => {
  const schema: any = {
    version: 1,
    folders: {},
    lists: {
      items: {
        label: 'Items',
        key: 'id',
        columns: { id: { type: 'text', label: 'ID' }, active: { type: 'checkbox', label: 'Active', default: 'false' } },
      },
    },
  };
  validateStructure(schema);
  assert.equal(planStructure(schema, schema, { items: [{ id: 'one' }] }).items[0].active, 'false');
  const invalid = structuredClone(schema);
  invalid.lists.items.columns.active.default = 'maybe';
  assert.throws(() => validateStructure(invalid));
  const root = await mkdtemp(join(tmpdir(), 'cms-checkbox-'));
  try {
    await mkdir(join(root, 'schema'));
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    const store = new Store(root);
    let snapshot = await store.snapshot('items');
    snapshot = await store.update('items', [{ id: 'one', active: 'true' }], snapshot.revision);
    assert.equal(snapshot.rows[0].active, 'true');
    snapshot = await store.update('items', [{ id: 'one', active: 'false' }], snapshot.revision);
    assert.equal(snapshot.rows[0].active, 'false');
    await assert.rejects(store.update('items', [{ id: 'one', active: 'maybe' }], snapshot.revision));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
