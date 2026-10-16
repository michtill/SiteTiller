import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { writeDesignStructure } from '../server/design-structure.ts';
import { schemaSnapshot } from '../server/structure.ts';
import { restoreRevision } from '../server/design-restore.ts';
const initial = {
  version: 1,
  folders: { docs: { label: 'Docs', type: 'other' } },
  lists: {
    items: {
      label: 'Items',
      key: 'id',
      columns: { id: { label: 'ID', type: 'text', readonly: true }, title: { label: 'Title', type: 'text' } },
    },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'design-structure-'));
  for (const p of ['schema', 'data', 'media/docs']) await mkdir(join(root, p), { recursive: true });
  await writeFile(join(root, 'schema/structure.json'), JSON.stringify(initial));
  await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Preserve"}]');
  await writeFile(join(root, 'media/docs/keep.txt'), 'asset');
  return root;
}
async function request(root, schema) {
  return {
    schema,
    schemaRevision: (await schemaSnapshot(root)).revision,
    expectedRevision: await restoreRevision(root),
  };
}
function candidate() {
  const schema = structuredClone(initial);
  schema.lists.items.columns.status = { label: 'Status', type: 'text', required: true, default: 'Draft' };
  schema.lists.extras = { label: 'Extras', key: 'id', columns: { id: { label: 'ID', type: 'text' } } };
  return schema;
}
test('AI-05: AI structure uses editor migration with inert dry-run, no-op, atomic rows/schema and callback rollback', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      body = await request(root, candidate()),
      before = await restoreRevision(root);
    let commits = 0;
    const dry = await writeDesignStructure(store, { ...body, dryRun: true }, async () => {
      commits++;
    });
    assert.equal(dry.validated, true);
    assert.equal(dry.collections.items[0].status, 'Draft');
    assert.deepEqual(dry.collections.extras, []);
    assert.equal(await restoreRevision(root), before);
    assert.equal(commits, 0);
    await assert.rejects(readdir(join(root, 'backups')), (e) => e.code === 'ENOENT');
    const noop = await writeDesignStructure(store, await request(root, initial), async () => {
      commits++;
    });
    assert.equal(noop.changed, false);
    assert.equal(commits, 0);
    await assert.rejects(
      writeDesignStructure(store, body, async () => {
        throw Error('Live-disable failure');
      }),
      /Live-disable failure/,
    );
    assert.equal(await restoreRevision(root), before);
    await assert.rejects(readFile(join(root, 'data/extras.json')), (e) => e.code === 'ENOENT');
    await assert.rejects(readFile(join(root, '.structure-transaction.json')), (e) => e.code === 'ENOENT');
    const result = await writeDesignStructure(store, body, async () => {
      commits++;
    });
    assert.equal(result.changed, true);
    assert.equal(result.schema.version, 2);
    assert.equal(commits, 1);
    assert.equal(result.lists.items.rows[0].title, 'Preserve');
    assert.equal(result.lists.items.rows[0].status, 'Draft');
    assert.deepEqual(result.lists.extras.rows, []);
    assert.notEqual(result.contentRevision, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-05: invalid/destructive schema and stale schema/rows/media CAS cannot partially mutate', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      baseline = await restoreRevision(root),
      body = await request(root, candidate());
    const badSchemas = [
      { ...initial, lists: { items: { ...initial.lists.items, key: 'missing' } } },
      { ...initial, lists: {} },
      { ...initial, folders: {} },
      { ...initial, lists: { items: { ...initial.lists.items, columns: { id: initial.lists.items.columns.id } } } },
      {
        ...initial,
        lists: {
          items: {
            ...initial.lists.items,
            columns: { ...initial.lists.items.columns, relation: { label: 'Relation', type: 'list', list: 'missing' } },
          },
        },
      },
      {
        ...initial,
        lists: {
          items: {
            ...initial.lists.items,
            columns: { ...initial.lists.items.columns, required: { label: 'Required', type: 'text', required: true } },
          },
        },
      },
    ];
    for (const schema of badSchemas) {
      await assert.rejects(writeDesignStructure(store, { ...body, schema }), (e) => e.status === 422);
      assert.equal(await restoreRevision(root), baseline);
    }
    await assert.rejects(
      writeDesignStructure(store, { ...body, schemaRevision: '0'.repeat(64) }),
      (e) => e.status === 409,
    );
    await assert.rejects(writeDesignStructure(store, { ...body, path: 'schema/evil.json' }), (e) => e.status === 422);
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Concurrent"}]');
    const changedRows = await restoreRevision(root);
    await assert.rejects(writeDesignStructure(store, body), (e) => e.status === 409);
    assert.equal(await restoreRevision(root), changedRows);
    const refreshed = await request(root, candidate());
    await writeFile(join(root, 'media/docs/keep.txt'), 'Concurrent asset');
    const changedAssets = await restoreRevision(root);
    await assert.rejects(writeDesignStructure(store, refreshed), (e) => e.status === 409);
    assert.equal(await restoreRevision(root), changedAssets);
    assert.deepEqual(await store.schema(), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-05: combined candidate schema, new rows/assets validate and commit together or roll back together', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      schema = candidate();
    schema.folders.newDocs = { label: 'New documents', type: 'other' };
    schema.lists.items.columns.requiredNew = { label: 'Required new', type: 'text', required: true };
    schema.lists.extras.columns.parent = { label: 'Parent', type: 'list', list: 'items', required: true };
    schema.lists.extras.columns.file = { label: 'File', type: 'file', folder: 'newDocs', required: true };
    const body = {
      ...(await request(root, schema)),
      changes: [
        {
          collection: 'items',
          revision: (await store.snapshot('items')).revision,
          rows: [{ id: 'one', title: 'Edited', status: 'Ready', requiredNew: 'Initialized' }],
        },
        {
          collection: 'extras',
          revision: (await import('node:crypto')).createHash('sha256').update('[]\n').digest('hex'),
          rows: [{ id: 'two', parent: 'one', file: 'newDocs/new.txt' }],
        },
      ],
      assets: [{ folder: 'newDocs', name: 'new.txt', data: Buffer.from('new asset').toString('base64') }],
    };
    const before = await restoreRevision(root);
    let committed = 0;
    const dry = await writeDesignStructure(store, { ...body, dryRun: true }, async () => {
      committed++;
    });
    assert.equal(dry.collections.extras[0].parent, 'one');
    assert.equal(dry.collections.items[0].status, 'Ready');
    assert.equal(await restoreRevision(root), before);
    assert.equal(committed, 0);
    await assert.rejects(readFile(join(root, 'media/newDocs/new.txt')), (e) => e.code === 'ENOENT');
    const invalid = structuredClone(body);
    invalid.changes[1].rows[0].parent = 'absent';
    await assert.rejects(writeDesignStructure(store, invalid), (e) => e.status === 422);
    assert.equal(await restoreRevision(root), before);
    const stale = structuredClone(body);
    stale.changes[0].revision = '0'.repeat(64);
    await assert.rejects(writeDesignStructure(store, stale), (e) => e.status === 409);
    assert.equal(await restoreRevision(root), before);
    await assert.rejects(
      writeDesignStructure(store, body, async () => {
        throw Error('combined failure');
      }),
      /combined failure/,
    );
    assert.equal(await restoreRevision(root), before);
    await assert.rejects(readFile(join(root, 'media/newDocs/new.txt')), (e) => e.code === 'ENOENT');
    await assert.rejects(readFile(join(root, 'data/extras.json')), (e) => e.code === 'ENOENT');
    const result = await writeDesignStructure(store, body, async () => {
      committed++;
    });
    assert.equal(committed, 1);
    assert.equal(result.schema.version, 2);
    assert.equal(result.lists.extras.rows[0].file, 'newDocs/new.txt');
    assert.equal(result.lists.items.rows[0].title, 'Edited');
    assert.equal(await readFile(join(root, 'media/newDocs/new.txt'), 'utf8'), 'new asset');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
