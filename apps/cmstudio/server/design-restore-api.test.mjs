import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
test('AI-05: restore endpoint dry run is inert; actual restore disables live mode and leaves published snapshot intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-api-'));
  let child;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    const schema = {
      version: 1,
      lists: { old: { label: 'Old', key: 'id', columns: { id: { label: 'ID', type: 'text' } } } },
      folders: {},
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/old.json'), '[{"id":"original"}]');
    const origin = 'http://127.0.0.1:4626';
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        PORT: '4626',
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
    await call('/api/publication', {});
    boot = await (await fetch(origin + '/api/bootstrap')).json();
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 200);
    const state = await (await fetch(origin + '/api/design-restore-state')).json(),
      body = {
        expectedRevision: state.revision,
        dryRun: true,
        schema: {
          version: 2,
          lists: {
            next: {
              label: 'Next',
              key: 'id',
              columns: { id: { label: 'ID', type: 'text' }, file: { label: 'File', type: 'file', folder: 'docs' } },
            },
          },
          folders: { docs: { label: 'Docs', type: 'other' } },
        },
        collections: { next: [{ id: 'restored', file: 'docs/restored.txt' }] },
        assets: [{ folder: 'docs', name: 'restored.txt', data: Buffer.from('restored file').toString('base64') }],
      };
    assert.equal((await call('/api/design-restore', body)).status, 200);
    assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, true);
    assert.equal((await (await fetch(origin + '/api/bootstrap')).json()).schema.version, 1);
    assert.equal((await call('/api/design-restore', { ...body, expectedRevision: 'stale' })).status, 409);
    assert.equal((await call('/api/design-restore', { ...body, dryRun: false })).status, 200);
    const after = await (await fetch(origin + '/api/bootstrap')).json();
    assert.equal(after.autoPublish, false);
    assert.equal(after.schema.version, 2);
    assert.equal(after.lists.next.rows[0].id, 'restored');
    assert.equal(await (await fetch(origin + '/media/docs/restored.txt')).text(), 'restored file');
    assert.equal((await (await fetch(origin + '/published/schema/structure.json')).json()).version, 1);
    assert.notEqual((await (await fetch(origin + '/api/design-restore-state')).json()).revision, state.revision);
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
