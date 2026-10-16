import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { Publication } from '../server/publication.ts';
const root = await mkdtemp(join(tmpdir(), 'cms-publication-'));
try {
  await mkdir(join(root, 'schema'));
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'media/images'), { recursive: true });
  await writeFile(
    join(root, 'schema/structure.json'),
    JSON.stringify({
      version: 1,
      lists: {
        items: {
          label: 'Items',
          key: 'id',
          columns: { id: { type: 'text', label: 'ID' }, title: { type: 'text', label: 'Title' } },
        },
      },
      folders: { images: { label: 'Images', type: 'img' } },
    }),
  );
  await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"First"}]');
  await writeFile(join(root, 'media/images/a.png'), 'image');
  const store = new Store(root),
    pub = new Publication(root, store, join(root, '.production'));
  assert.equal((await pub.status()).unpublished, true);
  const first = await pub.publish();
  assert.equal((await pub.status()).unpublished, false);
  assert.equal((await pub.asset('media/images/a.png')).bytes.toString(), 'image');
  const snapshot = await store.snapshot('items');
  await store.update('items', [{ id: 'one', title: 'Changed' }], snapshot.revision);
  assert.equal((await pub.status()).unpublished, true);
  assert.equal(JSON.parse((await pub.asset('data/items.json')).bytes.toString())[0].title, 'First');
  const second = await pub.publish();
  assert.notEqual(first.published.id, second.published.id);
  assert.equal(JSON.parse((await pub.asset('data/items.json')).bytes.toString())[0].title, 'Changed');
  assert.equal(
    JSON.parse(await readFile(join(first.published.directory, 'data/items.json'), 'utf8'))[0].title,
    'First',
  );
  await assert.rejects(pub.asset('data/../settings.json'));
  console.log('PASS independent publication, changes, immutable previous release, media, traversal');
} finally {
  await rm(root, { recursive: true, force: true });
}
