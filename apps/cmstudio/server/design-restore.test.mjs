import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { SettingsStore } from './settings.ts';
import { restoreDesignContent, designRestoreState, recoverDesignRestore } from './design-restore.ts';
test('AI-05: restore replaces schema, collections and media, protects production, detects conflicts and rolls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-content-'));
  try {
    for (const p of ['schema', 'data', 'media/old', 'settings', '.production', '.cms-publication'])
      await mkdir(join(root, p), { recursive: true });
    const initial = {
      version: 1,
      folders: { old: { label: 'Old', type: 'other' } },
      lists: { old: { label: 'Old', key: 'id', columns: { id: { type: 'text', label: 'ID' } } } },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(initial));
    await writeFile(join(root, 'data/old.json'), '[{"id":"old"}]');
    await writeFile(join(root, 'data/orphan.json'), '["untracked"]');
    await writeFile(join(root, 'media/old/file.txt'), 'old file');
    await writeFile(join(root, '.production/current.json'), 'production protected');
    await writeFile(join(root, '.cms-publication/current.json'), 'published protected');
    const settings = new SettingsStore(root);
    await writeFile(join(root, 'settings/shared.json'), JSON.stringify({ name: 'Keep name', theme: 'green' }));
    let live = true;
    const store = new Store(root),
      state = await designRestoreState(store);
    const crashId = randomUUID(),
      crashBackup = join(root, 'backups', 'restore-' + crashId, 'before');
    await mkdir(crashBackup, { recursive: true });
    await rename(join(root, 'schema'), join(crashBackup, 'schema'));
    await mkdir(join(root, 'schema'));
    await writeFile(join(root, 'schema/structure.json'), 'partial replacement');
    await writeFile(join(root, '.design-restore-transaction.json'), JSON.stringify({ id: crashId }));
    await recoverDesignRestore(root);
    assert.equal((await designRestoreState(store)).revision, state.revision);
    const schema = {
      version: 3,
      settings: { name: 'IGNORE THIS' },
      folders: { images: { label: 'Images', type: 'img' } },
      lists: {
        new: {
          label: 'New',
          key: 'id',
          columns: { id: { label: 'ID', type: 'text' }, image: { label: 'Image', type: 'file', folder: 'images' } },
        },
      },
    };
    const body = {
      schema,
      collections: { new: [{ id: 'one', image: 'images/photo.png' }] },
      assets: [{ folder: 'images', name: 'photo.png', data: Buffer.from('historical image').toString('base64') }],
      expectedRevision: state.revision,
      dryRun: true,
    };
    let disabled = 0;
    const disable = async () => {
      live = false;
      disabled++;
    };
    await restoreDesignContent(store, body, disable);
    assert.equal((await designRestoreState(store)).revision, state.revision);
    assert.equal(disabled, 0);
    assert.equal(live, true);
    await assert.rejects(
      restoreDesignContent(store, { ...body, expectedRevision: 'stale' }, disable),
      (e) => e.status === 409,
    );
    await assert.rejects(restoreDesignContent(store, { ...body, assets: [] }, disable), (e) => e.status === 422);
    await assert.rejects(
      restoreDesignContent(store, { ...body, dryRun: false }, disable, async (from, to) => {
        if (from.replaceAll(String.fromCharCode(92), '/').endsWith('stage/data')) throw Error('Injected swap failure');
        await rename(from, to);
      }),
      /swap failure/,
    );
    assert.equal((await designRestoreState(store)).revision, state.revision);
    assert.equal(disabled, 0);
    await restoreDesignContent(store, { ...body, dryRun: false }, disable);
    assert.equal(disabled, 1);
    assert.equal((await store.schema()).version, 3);
    assert.equal((await store.schema()).settings, undefined);
    assert.deepEqual(await readdir(join(root, 'data')), ['new.json']);
    assert.deepEqual(await readdir(join(root, 'media')), ['images']);
    assert.equal(await readFile(join(root, 'media/images/photo.png'), 'utf8'), 'historical image');
    assert.equal((await settings.snapshot()).settings.name, 'Keep name');
    assert.equal(live, false);
    assert.equal(await readFile(join(root, '.production/current.json'), 'utf8'), 'production protected');
    assert.equal(await readFile(join(root, '.cms-publication/current.json'), 'utf8'), 'published protected');
    assert.notEqual((await designRestoreState(store)).revision, state.revision);
    const beforeAssets = (await designRestoreState(store)).revision;
    await writeFile(join(root, 'media/images/photo.png'), 'manual change');
    await assert.rejects(
      restoreDesignContent(store, { ...body, expectedRevision: beforeAssets }, disable),
      (e) => e.status === 409,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
