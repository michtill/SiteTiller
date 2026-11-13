import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { passwordHash, validateShared } from '../packages/settings/index.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test('OP-13: the editor address entered in Settings applies at once next to the installation address, which stays as a fallback; only /health answers on any host name', async () => {
  // The address: HTTPS, plain HTTP only locally, no path; empty = the installation's.
  const base = { name: 'Web', theme: 'light' };
  assert.equal(validateShared({ ...base, editOrigin: 'https://edit.example.cz/' }).editOrigin, 'https://edit.example.cz');
  assert.equal(validateShared({ ...base, editOrigin: 'http://edit.localhost:8080' }).editOrigin, 'http://edit.localhost:8080');
  assert.equal(validateShared({ ...base, editOrigin: '' }).editOrigin, '');
  for (const wrong of ['http://edit.example.cz', 'https://edit.example.cz/app', 'ftp://edit.example.cz', 'nonsense'])
    assert.throws(() => validateShared({ ...base, editOrigin: wrong }), /adresu editoru/, wrong);
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-edit-origin-')),
    port = await freePort(),
    installed = 'http://127.0.0.1:' + port,
    chosenHost = 'edit.localhost:' + port,
    chosen = 'http://' + chosenHost;
  let shell;
  try {
    await mkdir(join(root, 'settings'), { recursive: true });
    await writeFile(join(root, 'settings/auth.json'), JSON.stringify({ password: passwordHash('fixture-password-12') }));
    await writeFile(
      join(root, 'settings/shared.json'),
      JSON.stringify({ name: 'Modrý Kocour', theme: 'light', adminEmail: 'admin@example.test' }),
    );
    shell = spawn(process.execPath, [join(repo, 'apps/shell/server.ts')], {
      cwd: repo,
      env: {
        ...process.env,
        PORT: String(port),
        EDIT_ORIGIN: installed,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_GATEWAY_TOKEN: 'g'.repeat(64),
        SITETILLER_PUBLIC_PREVIEW_ORIGIN: 'http://pre.localhost:' + port,
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(installed + '/login')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // A request under any host name (the Shell is reached at 127.0.0.1, the Host header names the address).
    const request = (host, path, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path, method: options.method || 'GET', headers: { host, ...(options.headers || {}) } },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          },
        );
        req.on('error', reject);
        req.end(options.body);
      });
    const signIn = async (host) => {
      const login = await request(host, '/login', {
        method: 'POST',
        headers: { origin: 'http://' + host, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=fixture-password-12',
      });
      assert.equal(login.status, 303, host);
      return login.headers['set-cookie'][0].split(';')[0];
    };
    const installedHost = '127.0.0.1:' + port,
      cookie = await signIn(installedHost);
    // Before: only the installation's address; another host name is refused.
    assert.equal((await request(chosenHost, '/login')).status, 403);
    const save = async (editOrigin) => {
      const form = (await request(installedHost, '/settings/addresses', { headers: { cookie } })).body;
      return request(installedHost, '/settings/addresses', {
        method: 'POST',
        headers: { cookie, origin: installed, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'preview',
          revision: form.match(/name="revision" value="([^"]+)"/)[1],
          editOrigin,
          returnTo: '/',
        }).toString(),
      });
    };
    // Wrong addresses are refused with the reason and nothing is saved.
    for (const wrong of ['http://edit.example.cz', chosen + '/app', 'http://pre.localhost:' + port]) {
      const refused = await save(wrong);
      assert.equal(refused.status, 422, wrong);
      assert.equal((await request(chosenHost, '/login')).status, 403);
    }
    // Saved: it applies at once, without a restart, and the field shows it.
    const saved = await save(chosen);
    assert.equal(saved.status, 200);
    assert.ok(saved.body.includes('name="editOrigin" type="url" maxlength="300" value="' + chosen + '"'));
    assert.equal((await request(chosenHost, '/login')).status, 200);
    const chosenCookie = await signIn(chosenHost);
    assert.equal((await request(chosenHost, '/settings/addresses', { headers: { cookie: chosenCookie } })).status, 200);
    // The MCP address is the chosen one; OAuth answers on both addresses.
    const mcp = (await request(chosenHost, '/settings/mcp', { headers: { cookie: chosenCookie } })).body;
    assert.ok(mcp.includes(chosen + '/mcp'));
    // The installation's address stays as the fallback, its sign-in still valid; other host names stay refused.
    assert.equal((await request(installedHost, '/settings/addresses', { headers: { cookie } })).status, 200);
    assert.equal((await request('other.localhost:' + port, '/login')).status, 403);
    // Only the healthcheck answers under any host name, with nothing but "ok".
    const health = await request('healthcheck.example.app', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body, 'ok');
    assert.equal((await request('healthcheck.example.app', '/health', { method: 'POST' })).status, 403);
    assert.equal((await request('healthcheck.example.app', '/health/x')).status, 403);
    // A form from one address is not accepted on the other.
    const crossed = await request(chosenHost, '/settings', {
      method: 'POST',
      headers: { cookie: chosenCookie, origin: installed, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    assert.equal(crossed.status, 403);
    // Empty field = the installation's address only.
    assert.equal((await save('')).status, 200);
    assert.equal((await request(chosenHost, '/login')).status, 403);
    assert.equal((await request(installedHost, '/login')).status, 200);
  } finally {
    if (shell) {
      const exited = new Promise((r) => shell.once('exit', r));
      shell.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
