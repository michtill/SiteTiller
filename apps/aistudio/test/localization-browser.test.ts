import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import { Project } from '../src/project.ts';
import { initialTeam, initialImages } from '../src/team.ts';
const gateway = 'fixture-gateway-token';
test('I18-01: interface follows the chosen language and falls back to English', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-locale-'));
  let child: any, browser: any;
  try {
    const p = new Project(join(data, 'project'));
    await p.init(null);
    const password = 'fixture-password-sitetiller',
      salt = 'salt';
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        password: { salt, hash: scryptSync(password, salt, 64).toString('hex') },
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        requests: [],
        releases: [],
      }),
    );
    const port = 21600 + Math.floor(Math.random() * 100),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/provider-server.mjs', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        SITETILLER_DATA_DIR: data,
        HOST: '127.0.0.1',
        PORT: String(port),
        SITETILLER_ORIGIN: origin,
        SITETILLER_UI_LANGUAGE: '',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setExtraHTTPHeaders({ 'x-sitetiller-gateway': gateway });
    await page.goto(origin);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.locator('#prompt').waitFor();
    assert.equal(await page.locator('#edits-tab').textContent(), 'Edits');
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-label'), 'Switch to light mode');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-label'), 'Switch to dark mode');
    await page.evaluate(() => localStorage.setItem('sitetiller-language', 'cs'));
    await page.reload();
    await page.locator('#prompt').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'cs');
    assert.equal(await page.locator('#edits-tab').textContent(), 'Úpravy');
    // The sun/moon is only for a while: after a reload the colour mode of the settings applies again (documentation 2.4).
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-label'), 'Zapnout světlý režim');
    // A language this installation does not offer falls back to English.
    await page.evaluate(() => localStorage.setItem('sitetiller-language', 'xx'));
    await page.reload();
    await page.locator('#prompt').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#edits-tab').textContent(), 'Edits');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (child && child.exitCode === null) {
      const ended = new Promise((r) => child.once('exit', r));
      child.kill();
      await ended;
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
