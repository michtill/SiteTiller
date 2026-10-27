import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Publication } from '../server/publication.ts';
import { Store } from '../server/store.ts';
import { SettingsStore } from '../server/settings.ts';
import { restoreRevision } from '../server/design-restore.ts';
const schema = {
  version: 1,
  lists: {
    items: {
      key: 'id',
      label: 'Items',
      columns: { id: { type: 'text', label: 'ID' }, title: { type: 'text', label: 'Title' } },
    },
  },
  folders: {},
};
test('PU-05: external production root, frozen content, CAS and concurrent pointer rejection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cmstudio-production-'));
  try {
    const root = join(temp, 'instance'),
      production = join(temp, 'external-production'),
      directory = join(production, 'baseline');
    for (const p of [join(root, 'schema'), join(root, 'media'), join(root, 'data'), join(directory, 'cms/data')])
      await mkdir(p, { recursive: true });
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Draft"}]');
    await writeFile(join(directory, 'cms/structure.json'), JSON.stringify(schema));
    await writeFile(join(directory, 'cms/data/items.json'), '[{"id":"one","title":"Published"}]');
    await writeFile(join(directory, 'index.html'), 'UNCHANGED DESIGN');
    const pointer = join(production, 'current.json');
    await writeFile(pointer, JSON.stringify({ id: 'baseline', directory }));
    const pub = new Publication(root, new Store(root), production);
    await pub.initialize();
    assert.equal(JSON.parse((await pub.asset('data/items.json')).bytes)[0].title, 'Published');
    const before = await readFile(pointer, 'utf8');
    await assert.rejects(pub.publish(undefined, '0'.repeat(64)), (e) => e.status === 409);
    assert.equal(await readFile(pointer, 'utf8'), before);
    await pub.publish(undefined, await restoreRevision(root));
    const active = JSON.parse(await readFile(pointer, 'utf8'));
    assert.equal(JSON.parse(await readFile(join(active.directory, 'cms/data/items.json'), 'utf8'))[0].title, 'Draft');
    assert.equal(await readFile(join(active.directory, 'index.html'), 'utf8'), 'UNCHANGED DESIGN');
    assert.ok(active.directory.startsWith(join(production, 'releases')));
    await assert.rejects(readFile(join(root, '.production/current.json')), (e) => e.code === 'ENOENT');
    assert.equal((await pub.status()).unpublished, false);
    const files = await pub.files();
    const published = await pub.pointer();
    const original = pub.production.bind(pub);
    let reads = 0;
    const moved = { ...active, id: 'concurrently-changed' };
    pub.production = async () => {
      if (++reads === 2) {
        await writeFile(pointer, JSON.stringify(moved));
        return moved;
      }
      return original();
    };
    await assert.rejects(pub.exportProduction(published, files), (e) => e.status === 409);
    assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), moved);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('ED-18: the Editor reads name, theme and default edit mode from the Shared settings and never writes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmstudio-settings-'));
  try {
    await mkdir(join(root, 'settings'));
    await mkdir(join(root, 'cms'));
    const shared = join(root, 'settings/shared.json');
    await writeFile(shared, '{"name":"Shared site","theme":"blue"}');
    await writeFile(join(root, 'cms/settings.json'), '{"name":"Legacy","theme":"plum","autoPublish":true}');
    const store = new SettingsStore(root);
    // The legacy cms/settings.json is ignored.
    assert.deepEqual(await store.snapshot(), { settings: { name: 'Shared site', theme: 'light' } });
    assert.equal(await store.liveByDefault(), false);
    await writeFile(shared, '{"name":"Renamed","theme":"sand","contentDefault":"live"}');
    assert.equal((await store.snapshot()).settings.name, 'Renamed');
    assert.equal(await store.liveByDefault(), true);
    await writeFile(shared, '{"name":"","theme":"sand"}');
    await assert.rejects(store.snapshot(), (e) => e.status === 422);
    assert.equal(await readFile(shared, 'utf8'), '{"name":"","theme":"sand"}');
    await assert.rejects(readFile(join(root, 'settings/cmstudio.json')), (e) => e.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
