import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { schemaSnapshot } from '../server/structure.ts';
import { fileInFolder } from '../file-field.ts';
test('ED-02: Soubor musí být v určené složce a existovat; změna složky nesmí zneplatnit data', async () => {
  assert.equal(fileInFolder('web-data/photos/a.png', 'photos'), 'photos/a.png');
  assert.equal(fileInFolder('documents/a.txt', 'photos'), null);
  assert.equal(fileInFolder('web-data/photos/../a.png', 'photos'), null);
  const root = await mkdtemp(join(tmpdir(), 'cms-file-'));
  try {
    for (const dir of ['schema', 'data', 'media/photos', 'media/documents'])
      await mkdir(join(root, dir), { recursive: true });
    const schema = {
      version: 1,
      folders: { photos: { label: 'Fotky', type: 'img' }, documents: { label: 'Dokumenty', type: 'other' } },
      lists: {
        assets: {
          label: 'Přílohy',
          key: 'code',
          columns: { code: { label: 'Kód', type: 'text' }, file: { label: 'Soubor', type: 'file', folder: 'photos' } },
        },
      },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/assets.json'), '[]');
    await writeFile(join(root, 'media/photos/a.png'), 'image');
    await writeFile(join(root, 'media/documents/a.txt'), 'text');
    const store = new Store(root),
      initial = await store.snapshot('assets');
    await assert.rejects(
      store.update('assets', [{ code: 'a', file: 'web-data/documents/a.txt' }], initial.revision),
      /určené složky/,
    );
    await assert.rejects(
      store.update('assets', [{ code: 'a', file: 'web-data/photos/missing.png' }], initial.revision),
      /neexistuje/,
    );
    await store.update('assets', [{ code: 'a', file: 'web-data/photos/a.png' }], initial.revision);
    const changed = JSON.parse(JSON.stringify(schema));
    changed.lists.assets.columns.file.folder = 'documents';
    await assert.rejects(store.updateSchema(changed, (await schemaSnapshot(root)).revision), /existující soubor/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
