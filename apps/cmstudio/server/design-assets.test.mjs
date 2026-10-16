import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { schemaSnapshot } from './structure.ts';
import { writeDesignContent, commitWorkingTransaction } from './design-content.ts';
test('AI-05: new assets validate, dry-run, support row references and rollback without overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-assets-'));
  try {
    for (const d of ['schema', 'data', 'media', 'media/images', 'backups', '.cms-publication'])
      await mkdir(join(root, d));
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: { images: { label: 'Images', type: 'img' }, docs: { label: 'Docs', type: 'other' } },
        lists: {
          items: {
            label: 'Items',
            key: 'id',
            columns: { id: { label: 'ID', type: 'text' }, image: { label: 'Image', type: 'file', folder: 'images' } },
          },
        },
      }),
    );
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","image":""}]');
    await writeFile(join(root, '.cms-publication/current.json'), 'untouched');
    const store = new Store(root),
      schemaRevision = (await schemaSnapshot(root)).revision,
      revision = (await store.snapshot('items')).revision,
      png = Buffer.from('image-bytes').toString('base64');
    let called = 0;
    const body = {
      schemaRevision,
      changes: [{ collection: 'items', revision, rows: [{ id: 'one', image: 'images/new.png' }] }],
      assets: [{ folder: 'images', name: 'new.png', data: png }],
    };
    await writeDesignContent(store, { ...body, dryRun: true }, async () => {
      called++;
    });
    await assert.rejects(lstat(join(root, 'media/images/new.png')));
    assert.equal(called, 0);
    await assert.rejects(
      writeDesignContent(store, { ...body, assets: [{ folder: 'images', name: '../new.png', data: png }] }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      writeDesignContent(store, { ...body, assets: [{ folder: 'images', name: 'new.exe', data: png }] }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      writeDesignContent(store, { ...body, assets: [{ folder: 'missing', name: 'new.png', data: png }] }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      writeDesignContent(store, { ...body, assets: [{ folder: 'images', name: 'new.png', data: 'a===' }] }),
      (e) => e.status === 422,
    );
    await writeDesignContent(store, body, async () => {
      called++;
    });
    assert.equal(called, 1);
    assert.equal(await readFile(join(root, 'media/images/new.png'), 'utf8'), 'image-bytes');
    assert.equal((await store.snapshot('items')).rows[0].image, 'images/new.png');
    await assert.rejects(
      writeDesignContent(store, { schemaRevision, changes: [], assets: body.assets }),
      (e) => e.status === 409,
    );
    assert.equal(await readFile(join(root, '.cms-publication/current.json'), 'utf8'), 'untouched');
    await assert.rejects(
      commitWorkingTransaction(root, {}, {}, undefined, undefined, { 'images/new.png': Buffer.from('replacement') }),
    );
    assert.equal(await readFile(join(root, 'media/images/new.png'), 'utf8'), 'image-bytes');
    const before = await readFile(join(root, 'data/items.json'), 'utf8');
    await assert.rejects(
      commitWorkingTransaction(
        root,
        { 'data/items.json': '[]' },
        { 'data/items.json': before },
        async () => {
          throw Error('disk failure');
        },
        undefined,
        { 'images/rollback.png': Buffer.from('new') },
      ),
      /disk failure/,
    );
    await assert.rejects(lstat(join(root, 'media/images/rollback.png')));
    assert.equal(await readFile(join(root, 'data/items.json'), 'utf8'), before);
    await writeDesignContent(store, {
      schemaRevision,
      changes: [],
      assets: [{ folder: 'docs', name: 'new.txt', data: Buffer.from('document').toString('base64') }],
    });
    assert.equal(await readFile(join(root, 'media/docs/new.txt'), 'utf8'), 'document');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
