import { stopOwnedChild } from '../scripts/processes.mjs';
import { launchBrowser, studioFrame } from './support/browser.mjs';
let studio;
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import { atomicJson, readJson, passwordMatches, revision, updateSettings } from '../packages/settings/index.mjs';
const execute = promisify(execFile),
  repo = resolve('.');
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function ready(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw Error('Child exited ' + child.exitCode + ' on ' + port + ': ' + (child.fixtureError || ''));
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.status) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout on ' + port);
}
test('SH-04: shared settings CAS rejects simultaneous stale writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'example-settings-'));
  try {
    const path = join(dir, 'shared.json'),
      old = { name: 'Original', theme: 'green' };
    await atomicJson(path, old);
    const result = await Promise.allSettled([
      updateSettings(path, { name: 'One', theme: 'green' }, revision(old)),
      updateSettings(path, { name: 'Two', theme: 'blue' }, revision(old)),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(result.find((r) => r.status === 'rejected').reason.status, 409);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  'IN-01: shell, real AI/preview/website use isolated fixture content and shell-owned auth',
  { timeout: 90000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'example-integration-')),
      root = join(base, 'playground'),
      children = [];
    let cms;
    try {
      await execute(process.execPath, ['scripts/playground.mjs', 'init'], {
        windowsHide: true,
        cwd: repo,
        env: { ...process.env, SITETILLER_INSTANCES: base, SITETILLER_ADMIN_EMAIL: 'admin@example.test' },
        timeout: 30000,
      });
      const ports = {};
      for (const name of ['shell', 'aistudio', 'preview', 'publisher', 'website', 'cmstudio'])
        ports[name] = await freePort();
      // A contract stub, not the CMStudio implementation. It exercises proxy boundaries only.
      cms = http.createServer((req, res) => {
        if (req.url === '/api/publication') {
          res.setHeader('Content-Type', 'application/json');
          res.end('{"unpublished":false}');
        } else if (req.url === '/') {
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><head></head><body><h1>CM contract fixture</h1></body></html>');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((r) => cms.listen(ports.cmstudio, '127.0.0.1', r));
      const data = join(root, '.sitetiller'),
        production = join(root, '.production'),
        settings = join(root, 'settings'),
        gateway = (await readFile(join(settings, 'gateway.token'), 'utf8')).trim();
      const env = {
        ...process.env,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        SITETILLER_OFFLINE: '1',
        HOST: '127.0.0.1',
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_DATA_DIR: data,
        SITETILLER_CMS_ROOT: root,
        SITETILLER_CMS_URL: 'http://127.0.0.1:' + ports.cmstudio,
        SITETILLER_SHARED_SETTINGS_FILE: join(settings, 'shared.json'),
        SITETILLER_SHARED_AUTH_FILE: join(settings, 'auth.json'),
        SITETILLER_GATEWAY_TOKEN: gateway,
        SITETILLER_PUBLISH_TOKEN: (await readFile(join(settings, 'publish.token'), 'utf8')).trim(),
        SITETILLER_PUBLISH_URL: 'http://127.0.0.1:' + ports.publisher + '/publish',
        SITETILLER_PRODUCTION_HISTORY_DIR: join(production, 'repository.git'),
        SITETILLER_PRODUCTION_GIT: join(production, 'repository.git'),
        SITETILLER_PRODUCTION_DIRECTORY: production,
        SITETILLER_LOCAL_PRODUCTION_ROOT: production,
        SITETILLER_SITE_ORIGIN: 'http://127.0.0.1:' + ports.website,
        SITETILLER_SITE_URL: 'http://127.0.0.1:' + ports.website + '/',
        SITETILLER_ORIGIN: 'http://127.0.0.1:' + ports.aistudio,
        EDIT_ORIGIN: 'http://127.0.0.1:' + ports.shell,
        EDIT_HOST: '127.0.0.1',
        CMSTUDIO_PORT: String(ports.cmstudio),
        AISTUDIO_PORT: String(ports.aistudio),
        PREVIEW_PORT: String(ports.preview),
        SITETILLER_PREVIEW_URL: 'http://127.0.0.1:' + ports.shell + '/preview/',
        SITETILLER_WEBSITE_RUNTIME: '1',
      };
      for (const [name, entry] of [
        ['aistudio', 'apps/aistudio/src/server.ts'],
        ['preview', 'apps/aistudio/src/preview.ts'],
        ['publisher', 'apps/aistudio/src/publisher.ts'],
        ['website', 'apps/website/server.ts'],
        ['shell', 'apps/shell/server.ts'],
      ]) {
        const child = spawn(
          process.execPath,
          ['--import', pathToFileURL(join(repo, 'scripts/offline.mjs')).href, join(repo, entry)],
          {
            cwd: repo,
            env: { ...env, PORT: String(ports[name]) },
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        child.fixtureError = '';
        child.stderr.on('data', (chunk) => {
          child.fixtureError += chunk.toString();
        });
        children.push(child);
        await ready(ports[name], child);
      }
      const origin = 'http://127.0.0.1:' + ports.shell,
        password = (await readFile(join(settings, 'playground-password.txt'), 'utf8')).trim();
      let response = await fetch(origin + '/site/api/state', { redirect: 'manual' });
      assert.equal(response.status, 303);
      response = await fetch(origin + '/login', {
        method: 'POST',
        headers: { Origin: origin },
        body: new URLSearchParams({ password }),
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      const cookie = response.headers.get('set-cookie').split(';')[0],
        headers = { Cookie: cookie, Origin: origin };
      response = await fetch(origin + '/site/api/state', { headers });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.equal(
        state.providers.some((p) => p.hasKey),
        false,
      );
      assert.deepEqual(state.cmsPreviewSources, { published: true, unpublished: true });
      assert.ok(state.previewUrl.startsWith(origin + '/preview/access/'));
      assert.match(await (await fetch(origin + '/content/', { headers })).text(), /CM contract fixture/);
      assert.doesNotMatch(await (await fetch(origin + '/site/', { headers })).text(), /aria-label="Společná navigace"/);
      const publicOrigin = 'http://127.0.0.1:' + ports.website;
      assert.match(await (await fetch(publicOrigin + '/')).text(), /Malý verzovaný obsah/);
      const before = await readFile(join(production, 'current.json'), 'utf8');
      const rows = await readJson(join(root, 'data/pages.json'));
      rows[0].title = 'Draft fixture only';
      await writeFile(join(root, 'data/pages.json'), JSON.stringify(rows));
      assert.match(await (await fetch(state.previewUrl + 'sources/unpublished/')).text(), /Draft fixture only/);
      assert.match(await (await fetch(state.previewUrl + 'sources/published/')).text(), /SiteTiller playground/);
      assert.doesNotMatch(await (await fetch(publicOrigin + '/')).text(), /Draft fixture only/);
      assert.equal(await readFile(join(production, 'current.json'), 'utf8'), before);
      response = await fetch(origin + '/password', {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          currentPassword: password,
          newPassword: 'fixture-password-new',
          confirmPassword: 'fixture-password-new',
        }),
      });
      assert.equal(response.status, 200);
      assert.ok(passwordMatches('fixture-password-new', (await readJson(join(settings, 'auth.json'))).password));
      // The Shell owns the password; the AI Studio configuration keeps none.
      assert.equal((await readJson(join(data, 'config.json'))).password ?? null, null);
      assert.equal((await fetch(origin + '/site/api/state', { headers, redirect: 'manual' })).status, 303);
      response = await fetch(origin + '/login', {
        method: 'POST',
        headers: { Origin: origin },
        body: new URLSearchParams({ password: 'fixture-password-new' }),
        redirect: 'manual',
      });
      const newCookie = response.headers.get('set-cookie').split(';')[0];
      response = await fetch(origin + '/site/api/change-password', {
        method: 'POST',
        headers: { Cookie: newCookie, Origin: origin, 'Content-Type': 'application/json' },
        body: '{}',
      });
      // The AI Studio has no password endpoint; only the Shell changes the password.
      assert.equal(response.status, 404);
      assert.equal(
        (
          await fetch(origin + '/settings', {
            method: 'POST',
            headers: { Cookie: newCookie, Origin: 'http://example.invalid' },
            body: '',
          })
        ).status,
        403,
      );
      const shared = await readJson(join(settings, 'shared.json'));
      response = await fetch(origin + '/settings', {
        method: 'POST',
        headers: { Cookie: newCookie, Origin: origin },
        body: new URLSearchParams({ name: 'Updated fixture', theme: 'blue', revision: revision(shared) }),
      });
      assert.equal(response.status, 200);
      response = await fetch(origin + '/settings', {
        method: 'POST',
        headers: { Cookie: newCookie, Origin: origin },
        body: new URLSearchParams({ name: 'Stale fixture', theme: 'green', revision: revision(shared) }),
      });
      assert.equal(response.status, 409);
      const { chromium } = await import('playwright');
      const browser = await launchBrowser();
      try {
        const context = await browser.newContext();
        const page = await context.newPage(),
          errors = [];
        page.setDefaultTimeout(30000);
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(origin + '/login');
        await page.locator('input[name=password]').fill('fixture-password-new');
        await page.locator('button:not(.show-password)').first().click();
        await page.waitForURL('**/content/');
        studio = await studioFrame(page, 'content');
        // Offline there are no usable models; answering with none keeps AI Studio from leading to AI models.
        await page.route('**/site/api/models', (route) => route.fulfill({ json: { models: [], issues: [], optionalIssues: [] } }));
        await page.goto(origin + '/site/');
        studio = await studioFrame(page, 'site');
        await studio.locator('#workspace').waitFor({ state: 'visible' });
        await studio.locator('#preview').waitFor({ state: 'visible' });
        await studio.waitForFunction(() => document.getElementById('preview').src.includes('/preview/access/'));
        await studio.frameLocator('#preview').locator('h1').waitFor();
        assert.equal(await studio.frameLocator('#preview').locator('h1').textContent(), 'SiteTiller playground');
        await page.goto(origin + '/settings/aiapi?returnTo=%2Fsite%2F');
        await page.locator('h1').filter({ hasText: 'AI modely' }).waitFor();
        assert.equal(errors.length, 0, errors.join('\n'));
      } finally {
        await browser.close();
      }
    } finally {
      await Promise.all(children.map(stopOwnedChild));
      if (cms) {
        cms.closeAllConnections();
        await new Promise((r) => cms.close(r));
      }
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
test('OP-05: offline preload refuses provider traffic before any HTTP request', async () => {
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      './scripts/offline.mjs',
      '--input-type=module',
      '-e',
      "try{await fetch('https://api.openai.com/v1/models');process.exitCode=1}catch(e){console.log(e.message)}",
    ],
    { windowsHide: true, cwd: repo },
  );
  assert.match(stdout, /vypnuté.*offline/);
});
