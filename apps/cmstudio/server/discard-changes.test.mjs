import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { Publication } from './publication.ts';
import { discardChanges } from './discard-changes.ts';
import { designRestoreState } from './design-restore.ts';
test('ED-09: discard restores published schema, rows and nested assets with CAS and leaves production intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discard-changes-'));
  try {
    for (const p of [
      'schema',
      'data',
      'media/docs/nested',
      '.production/release/cms/data',
      '.production/release/cms/files/docs/nested',
    ])
      await mkdir(join(root, p), { recursive: true });
    const schema = {
      version: 1,
      folders: { docs: { label: 'Docs', type: 'other' } },
      lists: {
        items: {
          label: 'Items',
          key: 'id',
          columns: { id: { label: 'ID', type: 'text' }, file: { label: 'File', type: 'file', folder: 'docs' } },
        },
      },
    };
    for (const p of ['schema/structure.json', '.production/release/cms/structure.json'])
      await writeFile(join(root, p), JSON.stringify(schema));
    for (const p of ['data/items.json', '.production/release/cms/data/items.json'])
      await writeFile(join(root, p), '[{"id":"original","file":"docs/nested/keep.txt"}]');
    for (const p of ['media/docs/nested/keep.txt', '.production/release/cms/files/docs/nested/keep.txt'])
      await writeFile(join(root, p), 'published file');
    await writeFile(
      join(root, '.production/current.json'),
      JSON.stringify({ id: 'prod-original', directory: join(root, '.production/release') }),
    );
    const prodBefore = await readFile(join(root, '.production/current.json'), 'utf8'),
      store = new Store(root),
      pub = new Publication(root, store, join(root, '.production'));
    await pub.initialize();
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify({ ...schema, version: 2 }));
    await writeFile(join(root, 'data/items.json'), '[{"id":"working","file":"docs/nested/keep.txt"}]');
    await writeFile(join(root, 'data/orphan.json'), '[]');
    await writeFile(join(root, 'media/docs/nested/keep.txt'), 'working file');
    await writeFile(join(root, 'media/docs/new.txt'), 'new file');
    let live = true;
    const state = await designRestoreState(store);
    await assert.rejects(
      discardChanges(store, pub, { confirm: false, expectedRevision: state.revision }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      discardChanges(store, pub, { confirm: true, expectedRevision: '0'.repeat(64) }),
      (e) => e.status === 409,
    );
    await assert.rejects(pub.publish(undefined, '0'.repeat(64)), (e) => e.status === 409);
    await discardChanges(store, pub, { confirm: true, expectedRevision: state.revision }, async () => {
      live = false;
    });
    assert.equal((await store.schema()).version, 1);
    assert.equal((await store.snapshot('items')).rows[0].id, 'original');
    assert.deepEqual(await readdir(join(root, 'data')), ['items.json']);
    assert.equal(await readFile(join(root, 'media/docs/nested/keep.txt'), 'utf8'), 'published file');
    await assert.rejects(readFile(join(root, 'media/docs/new.txt')));
    assert.equal(live, false);
    assert.equal(await readFile(join(root, '.production/current.json'), 'utf8'), prodBefore);
    assert.equal((await pub.status()).unpublished, false);
    assert.equal((await readdir(join(root, 'backups'))).filter((name) => name.startsWith('restore-')).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
