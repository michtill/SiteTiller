import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
test('AI-05: Design dry run leaves live mode intact, real changes disable it and never publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-content-api-'));
  let child;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
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
        folders: {},
      }),
    );
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Initial"}]');
    const origin = 'http://127.0.0.1:4622';
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        PORT: '4622',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(origin + '/api/bootstrap')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    let boot = await (await fetch(origin + '/api/bootstrap')).json();
    const call = async (path, body, method = 'POST') => {
      if (path === '/api/publication') {
        const state = await (await fetch(origin + '/api/design-restore-state')).json();
        body = { confirm: true, expectedRevision: state.revision };
      }
      const res = await fetch(origin + path, {
        method,
        headers: { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, value: await res.json() };
    };
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 409);
    await call('/api/publication', {});
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 200);
    const changes = {
      schemaRevision: boot.schemaRevision,
      changes: [
        { collection: 'items', revision: boot.lists.items.revision, rows: [{ id: 'one', title: 'Changed by Design' }] },
      ],
    };
    assert.equal((await call('/api/design-content', { ...changes, dryRun: true })).status, 200);
    assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, true);
    assert.equal((await call('/api/design-content', { ...changes, schemaRevision: 'bad', dryRun: false })).status, 409);
    assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, true);
    assert.equal((await call('/api/design-content', { ...changes, dryRun: false })).status, 200);
    assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, false);
    await assert.rejects(readFile(join(root, 'settings/cmstudio.json')), (e) => e.code === 'ENOENT');
    assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].title, 'Changed by Design');
    assert.equal((await (await fetch(origin + '/published/data/items.json')).json())[0].title, 'Initial');
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 409);
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 409);
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
