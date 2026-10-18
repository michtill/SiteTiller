import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { publicPreviewPath } from '../apps/shell/public-preview.ts';
import { passwordHash } from '../packages/settings/index.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test('SH-10: the public preview path reaches only the current draft with the working content', () => {
  assert.equal(publicPreviewPath('/'), '/sources/unpublished/');
  assert.equal(publicPreviewPath('/contact/'), '/sources/unpublished/contact/');
  assert.equal(publicPreviewPath('/sources/unpublished/style.css'), '/sources/unpublished/style.css');
  assert.equal(publicPreviewPath('/sources/unpublished'), '/sources/unpublished/');
  for (const path of [
    '/versions/' + 'a'.repeat(40) + '/',
    '/sources/unpublished/versions/' + 'a'.repeat(40) + '/',
    '/snapshots/versions/' + 'a'.repeat(40) + '/',
    '/drafts/draft-' + 'b'.repeat(32) + '/',
    '/sources/published/',
    '/sources/unpublished/sources/published/',
    '/health',
    '/a/%2e%2e/versions/',
    '/a/..%2fversions/',
  ])
    assert.equal(publicPreviewPath(path), null, path);
});
test('SH-10: the Shell serves the public preview on its own address (and its own port) only while it is switched on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-public-preview-')),
    previewPort = await freePort(),
    shellPort = await freePort(),
    previewOnlyPort = await freePort(),
    seen = [];
  // The preview service stand-in records what reaches it.
  const preview = http
    .createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || '' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'leak=1',
        'Access-Control-Allow-Origin': 'null',
      });
      res.end('<h1>Draft</h1>');
    })
    .listen(previewPort, '127.0.0.1');
  let shell;
  try {
    await mkdir(join(root, 'settings'), { recursive: true });
    await writeFile(
      join(root, 'settings/auth.json'),
      JSON.stringify({ password: passwordHash('fixture-password-12') }),
    );
    const settings = (value) =>
      writeFile(join(root, 'settings/shared.json'), JSON.stringify({ name: 'Modrý Kocour', theme: 'green', ...value }));
    await settings({});
    const origin = 'http://127.0.0.1:' + shellPort,
      publicHost = 'localhost:' + shellPort;
    shell = spawn(process.execPath, [join(repo, 'apps/shell/server.ts')], {
      cwd: repo,
      env: {
        ...process.env,
        PORT: String(shellPort),
        EDIT_ORIGIN: origin,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_GATEWAY_TOKEN: 'g'.repeat(64),
        PREVIEW_PORT: String(previewPort),
        SITETILLER_PUBLIC_PREVIEW_ORIGIN: 'http://' + publicHost,
        SITETILLER_PUBLIC_PREVIEW_PORT: String(previewOnlyPort),
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/login')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const request = (path, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: options.port || shellPort,
            path,
            method: options.method || 'GET',
            headers: { host: publicHost, ...(options.headers || {}) },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          },
        );
        req.on('error', reject);
        req.end(options.body);
      });
    // Switched off: nothing.
    assert.equal((await request('/')).status, 404);
    assert.equal(seen.length, 0);
    await settings({ publicPreview: true });
    const page = await request('/contact/', { headers: { cookie: 'sitetiller_edit=' + 'c'.repeat(64) } });
    assert.equal(page.status, 200);
    assert.equal(page.body, '<h1>Draft</h1>');
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/sources/unpublished/contact/', cookie: '' });
    // Older steps, other sources, writes and studio sign-in do not exist there.
    const before = seen.length;
    assert.equal((await request('/versions/' + 'a'.repeat(40) + '/')).status, 404);
    assert.equal((await request('/sources/published/')).status, 404);
    assert.equal((await request('/', { method: 'POST', headers: { origin: 'http://' + publicHost } })).status, 404);
    assert.equal(seen.length, before);
    // Its own port (a hosting panel maps one port to one host name) serves the same preview under any host name
    // and never the studios: their paths are draft pages there.
    const own = await request('/contact/', { port: previewOnlyPort, headers: { host: 'new.example.cz' } });
    assert.equal(own.status, 200);
    assert.equal(own.body, '<h1>Draft</h1>');
    assert.equal((await request('/site/', { port: previewOnlyPort, headers: { host: 'new.example.cz' } })).status, 200);
    assert.equal(seen.at(-1).url, '/sources/unpublished/site/');
    assert.equal(
      (await request('/versions/' + 'a'.repeat(40) + '/', { port: previewOnlyPort })).status,
      404,
    );
    // The studios' own address is unchanged: it still asks for the password.
    assert.equal((await fetch(origin + '/site/', { redirect: 'manual' })).status, 303);
    // The switch in the common settings, with the preview address beside it.
    const login = await fetch(origin + '/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=fixture-password-12',
        redirect: 'manual',
      }),
      cookie = login.headers.get('set-cookie').split(';')[0],
      form = await (await fetch(origin + '/settings', { headers: { cookie } })).text();
    assert.match(form, /name="publicPreview" checked/);
    assert.ok(form.includes('http://' + publicHost + '/'));
    const saved = await fetch(origin + '/settings', {
      method: 'POST',
      headers: { cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Modrý Kocour',
        theme: 'green',
        language: 'cs',
        contentDefault: 'draft',
        publicPreviewOffered: '1',
        revision: form.match(/name="revision" value="([^"]+)"/)[1],
        returnTo: '/',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(saved.status, 303);
    // Switched off: gone at once, on both.
    assert.equal((await request('/')).status, 404);
    assert.equal((await request('/', { port: previewOnlyPort })).status, 404);
  } finally {
    if (shell) {
      const exited = new Promise((r) => shell.once('exit', r));
      shell.kill();
      await exited;
    }
    preview.close();
    await rm(root, { recursive: true, force: true });
  }
});
