import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { browserChecks, staticChecks } from '../src/checks.ts';
import { initialTeam, initialImages } from '../src/team.ts';
const gateway = 'fixture-gateway-token';
test('AI-18: deterministic browser checks detect page errors and mobile overflow with real screenshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-browser-'));
  try {
    const html =
      '<!doctype html><html><head><title>Test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Test</h1></body></html>';
    const files = { 'site/index.html': html };
    let result = await browserChecks(root, files);
    assert.equal(result.passed, true);
    assert.equal(result.screenshots.length, 2);
    assert.equal(result.checks.length, 2);
    result = await browserChecks(root, {
      'site/index.html': html.replace('</body>', '<script>throw new Error("fixture failure")</script></body>'),
    });
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes('fixture failure')));
    result = await browserChecks(root, {
      'site/index.html': html.replace('<h1>', '<div style="width:900px">Wide</div><h1>'),
    });
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes('390') && e.includes('overflow')));
    assert.equal(
      staticChecks({ 'site/index.html': html.replace('</body>', '<script>function ( broken }</script></body>') })
        .passed,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('CO-01: legacy settings migrate once without changing credentials/history; the studio has no settings window of its own', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-migrate-'));
  let child: any, browser: any;
  try {
    const password = 'fixture-password-sitetiller',
      salt = 'salt',
      legacy = {
        design: { provider: 'openai', model: 'old-design' },
        build: { provider: 'anthropic', model: 'old-build' },
        test: { provider: 'openai', model: 'old-test' },
        review: { provider: 'openai', model: 'old-review' },
      };
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        password: { salt, hash: scryptSync(password, salt, 64).toString('hex') },
        slots: [],
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: legacy,
        orchestrator: { provider: 'openai', model: 'old-router' },
        imageModel: 'old-image',
        requests: [],
        approvedCommit: null,
        publishedCommit: null,
      }),
    );
    const port = 19200 + Math.floor(Math.random() * 200),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/provider-server.mjs', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        SITETILLER_UI_LANGUAGE: 'cs',
        SITETILLER_DATA_DIR: data,
        HOST: '127.0.0.1',
        PORT: String(port),
        SITETILLER_ORIGIN: origin,
        OPENAI_API_KEY: 'fixture-openai',
        ANTHROPIC_API_KEY: 'fixture-claude',
        SITETILLER_TEST_CAPTURE: join(data, 'capture.json'),
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setExtraHTTPHeaders({ 'x-sitetiller-gateway': gateway });
    await page.goto(origin);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    // AI models are a settings screen of the Shell (tested in test/ai-models-page.test.mjs).
    await page.waitForFunction(() => !document.getElementById('workspace')!.hasAttribute('aria-busy'));
    assert.equal(await page.locator('#request-mode').count(), 0);
    assert.equal(await page.locator('#undo').count(), 0);
    assert.equal(await page.locator('#request-effort').count(), 0);
    assert.deepEqual(errors, []);
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=',
      'base64',
    );
    await page.locator('#image-files').setInputFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: pixel }]);
    await page.locator('#attachments img').waitFor();
    assert.equal(await page.locator('#attachments select,#attachments input').count(), 0);
    await page.locator('#attachments .remove-attachment').click();
    assert.equal(await page.locator('#attachments img').count(), 0);
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
    assert.equal(config.agentArchitecture, 3);
    assert.equal(await page.locator('#review').count(), 0);
    assert.deepEqual(config.legacyAgentSettings.roles, legacy);
    assert.deepEqual(config.roles, initialTeam());
    assert.deepEqual(config.imageModels, initialImages());
    // Saving with empty key fields keeps the stored (fixture) key.
    assert.ok(config.providers.openai.key);
    assert.equal(config.requests.length, 0);
  } finally {
    await browser?.close();
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    await rm(data, { recursive: true, force: true });
  }
});
test('AI-18: browser evidence exercises opening and closing mobile navigation instead of only taking a screenshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-mobile-toggle-'));
  try {
    const prefix =
      '<!doctype html><html><head><title>Nav</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="toggle" aria-controls="menu" aria-expanded="false">Menu</button><nav id="menu" hidden>Navigation</nav>';
    const working =
      prefix +
      '<script>document.getElementById("toggle").onclick=function(){const menu=document.getElementById("menu");menu.hidden=!menu.hidden;this.setAttribute("aria-expanded",String(!menu.hidden));};</script></body></html>';
    const result = await browserChecks(root, { 'site/index.html': working });
    assert.equal(result.passed, true);
    assert.equal(result.interactions.length, 1);
    assert.equal(result.interactions[0].opened.visible, true);
    assert.equal(result.interactions[0].closed.visible, false);
    assert.equal(result.interactions[0].restoredInitialState, true);
    const broken =
      prefix +
      '<script>document.getElementById("toggle").onclick=function(){this.setAttribute("aria-expanded","true");};</script></body></html>';
    const failed = await browserChecks(root, { 'site/index.html': broken });
    assert.equal(failed.passed, false);
    assert.ok(failed.errors.some((e) => e.includes('mobile toggle')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
