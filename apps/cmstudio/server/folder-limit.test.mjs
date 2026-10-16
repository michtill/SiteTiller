import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { validateStructure } from './structure.ts';
const schema = (folders) => ({
  version: 1,
  lists: { items: { label: 'Items', key: 'id', columns: { id: { type: 'text', label: 'ID' } } } },
  folders,
});
test('ED-20: a folder may set its largest file size, 1–100 whole MB', () => {
  for (const maxSizeMb of [1, 20, 100])
    assert.equal(
      validateStructure(schema({ docs: { label: 'Docs', type: 'other', maxSizeMb } })).folders.docs.maxSizeMb,
      maxSizeMb,
    );
  assert.ok(validateStructure(schema({ docs: { label: 'Docs', type: 'other' } })));
  for (const maxSizeMb of [0, 101, 2.5, '5', null])
    assert.throws(
      () => validateStructure(schema({ docs: { label: 'Docs', type: 'other', maxSizeMb } })),
      /maximální velikost souboru/,
      String(maxSizeMb),
    );
});
test('ED-20: uploads follow the folder limit; a folder without one keeps the 20 MB default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-folder-limit-'));
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  const origin = 'http://127.0.0.1:' + port;
  let child;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify(
        schema({ small: { label: 'Small', type: 'other', maxSizeMb: 1 }, docs: { label: 'Docs', type: 'other' } }),
      ),
    );
    await writeFile(join(root, 'data/items.json'), '[]');
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        PORT: String(port),
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
    const boot = await (await fetch(origin + '/api/bootstrap')).json();
    const upload = async (folder, bytes) => {
      const res = await fetch(origin + '/api/media?folder=' + folder + '&name=file.txt', {
        method: 'POST',
        headers: { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(bytes, 97),
      });
      return { status: res.status, value: await res.json() };
    };
    const mb = 1024 * 1024;
    assert.equal((await upload('small', mb)).status, 201);
    const refused = await upload('small', mb + 1);
    assert.equal(refused.status, 413);
    assert.equal(refused.value.error, 'Soubor překročil 1 MB.');
    // Without its own limit the folder takes 20 MB.
    assert.equal((await upload('docs', 2 * mb)).status, 201);
    assert.equal((await upload('docs', 20 * mb + 1)).status, 413);
  } finally {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
