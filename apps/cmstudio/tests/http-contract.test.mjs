import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
test('ST-07: mandatory instance and build roots have no source fallback', () => {
  const env = { ...process.env };
  delete env.SITETILLER_INSTANCE_ROOT;
  delete env.CMS_DIST;
  const missing = spawnSync(process.execPath, ['server/server.ts'], {
    cwd: moduleRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SITETILLER_INSTANCE_ROOT is required/);
  const build = spawnSync(process.execPath, ['server/server.ts'], {
    cwd: moduleRoot,
    env: { ...env, SITETILLER_INSTANCE_ROOT: tmpdir() },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /CMS_DIST is required/);
});
test('ST-07: explicit static root, custom settings paths, Host/Origin/token and studio CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmstudio-http-'));
  let child;
  try {
    const staticRoot = join(root, 'build');
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), 'ISOLATED BUILD');
    const shared = join(root, 'custom/shared.json');
    await mkdir(join(root, 'custom'));
    await writeFile(shared, '{"name":"Shell name","theme":"sand"}');
    const listener = createServer();
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    const origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: moduleRoot,
      env: {
        ...process.env,
        PORT: String(port),
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: staticRoot,
        SITETILLER_SHARED_SETTINGS_FILE: shared,
        SITETILLER_PRODUCTION_ROOT: join(root, 'production'),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    let boot;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(origin + '/api/bootstrap');
        if (r.ok) {
          boot = await r.json();
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(boot, 'fixture server became ready');
    const catalogResponse = await fetch(origin + '/api/field-catalog');
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.version, 1);
    assert.equal(catalog.types.length, 14);
    assert.equal(catalog.aliases.media, 'file');
    assert.equal((await (await fetch(origin + '/api/bootstrap')).json()).contentRevision, boot.contentRevision);
    assert.equal(boot.settings.name, 'Shell name');
    assert.equal(boot.settings.theme, 'sand');
    assert.equal(await (await fetch(origin + '/')).text(), 'ISOLATED BUILD');
    const foreignStatus = await new Promise((resolve, reject) => {
      const req = http.get(origin + '/api/bootstrap', { headers: { Host: 'foreign.invalid' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
    });
    assert.equal(foreignStatus, 403);
    // The edit mode is switched at runtime only; the Editor has no settings of its own to write.
    const switchMode = async (headers, value = { autoPublish: false }) =>
      fetch(origin + '/api/edit-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(value),
      });
    assert.equal((await switchMode({ Origin: origin })).status, 403);
    assert.equal((await switchMode({ Origin: 'http://foreign.invalid', 'X-CMS-Token': boot.token })).status, 403);
    const headers = { Origin: origin, 'X-CMS-Token': boot.token };
    assert.equal((await switchMode(headers, { autoPublish: 'yes' })).status, 422);
    assert.equal((await switchMode(headers)).status, 200);
    assert.equal((await fetch(origin + '/api/settings')).status, 404);
    assert.equal(await readFile(shared, 'utf8'), '{"name":"Shell name","theme":"sand"}');
    await assert.rejects(readFile(join(root, 'settings/cmstudio.json')), (e) => e.code === 'ENOENT');
    await assert.rejects(readFile(join(root, 'cms/settings.json')), (e) => e.code === 'ENOENT');
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
