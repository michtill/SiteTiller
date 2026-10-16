import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { mediaUsage, deleteMedia } from './media-delete.ts';
test('ED-07: file deletion blocks file and HTML references, preserves used files and backs up unused ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-delete-'));
  try {
    for (const p of ['schema', 'data', 'media/images']) await mkdir(join(root, p), { recursive: true });
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: { images: { label: 'Images', type: 'img' } },
        lists: {
          items: {
            label: 'Pages',
            key: 'id',
            display: 'title',
            columns: {
              id: { label: 'ID', type: 'text' },
              title: { label: 'Title', type: 'text' },
              photo: { label: 'Photo', type: 'file', folder: 'images' },
              html: { label: 'Text', type: 'html' },
            },
          },
        },
      }),
    );
    await writeFile(
      join(root, 'data/items.json'),
      JSON.stringify([
        {
          id: 'one',
          title: 'About me',
          photo: 'images/used.png',
          html: '<img src="/cms/files/images/inline%20photo.png?x=1"><a href="https://example.com/cms/files/images/remote.png">File</a>',
        },
      ]),
    );
    for (const name of ['used.png', 'inline photo.png', 'remote.png', 'free.png'])
      await writeFile(join(root, 'media/images', name), name);
    const store = new Store(root);
    for (const name of ['used.png', 'inline photo.png', 'remote.png']) {
      const usage = await mediaUsage(store, 'images/' + name);
      assert.equal(usage[0].collection, 'Pages');
      assert.equal(usage[0].record, 'About me');
      await assert.rejects(
        deleteMedia(store, 'images/' + name),
        (e) => e.status === 409 && e.message.includes('About me'),
      );
      assert.equal(await readFile(join(root, 'media/images', name), 'utf8'), name);
    }
    await assert.rejects(deleteMedia(store, 'images/../schema/structure.json'));
    await deleteMedia(store, 'images/free.png');
    await assert.rejects(readFile(join(root, 'media/images/free.png')));
    assert.equal((await readdir(join(root, 'backups/deleted-files'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
