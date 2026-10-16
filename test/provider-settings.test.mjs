import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog } from '../apps/aistudio/src/catalog.ts';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser, studioFrame, openAiSettings } from './support/browser.mjs';
let studio;
test('OP-05: provider mode allows only intended APIs; fixture offline remains explicit', () => {
  assert.equal(allowedNetworkURL('offline', 'https://api.openai.com/v1/models'), false);
  assert.equal(allowedNetworkURL('providers', 'https://api.openai.com/v1/models'), true);
  assert.equal(allowedNetworkURL('providers', 'https://api.anthropic.com/v1/models'), true);
  for (const url of [
    'https://example.com/',
    'http://api.openai.com/v1/models',
    'https://api.openai.com:444/v1/models',
    'https://api.openai.com.other/v1/models',
  ])
    assert.equal(allowedNetworkURL('providers', url), false);
  assert.equal(allowedNetworkURL('offline', 'http://127.0.0.1:4510/api/bootstrap'), true);
});
test('AI-33: catalog errors distinguish offline/network/auth/access/quota/rate without leaking bodies', async () => {
  for (const [status, code, kind] of [
    [401, 'invalid_api_key', 'authentication'],
    [403, 'permission_denied', 'access'],
    [429, 'insufficient_quota', 'quota'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [503, 'unknown', 'provider'],
  ]) {
    const result = await catalog({ openai: 'fixture-openai-key', anthropic: '' }, async () =>
      Response.json({ error: { code, message: 'must-not-leak-fixture-secret' } }, { status }),
    );
    assert.equal(result.providers[0].errorKind, kind);
    assert.equal(result.providers[0].httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|fixture-openai-key/);
  }
  const blocked = await catalog({ openai: 'fixture', anthropic: '' }, async () => {
    throw Object.assign(Error('blocked'), { code: 'ERR_SITETILLER_NETWORK_BLOCKED', networkMode: 'offline' });
  });
  assert.equal(blocked.providers[0].errorKind, 'blocked_network');
  const network = await catalog({ openai: 'fixture', anthropic: '' }, async () => {
    throw Error('ECONNRESET private body');
  });
  assert.equal(network.providers[0].errorKind, 'network');
  assert.doesNotMatch(JSON.stringify(network), /private body/);
});
test(
  'AI-33: real controller saves supplied fixture keys encrypted and validates stored keys through model-list only',
  { timeout: 240000 },
  async () => {
    const stack = await isolatedStack({
      networkMode: 'providers',
      controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
    });
    try {
      const login = await fetch(stack.origin + '/login', {
          method: 'POST',
          headers: { Origin: stack.origin },
          body: new URLSearchParams({ password: stack.password }),
          redirect: 'manual',
        }),
        cookie = login.headers.get('set-cookie').split(';')[0],
        headers = { Cookie: cookie, Origin: stack.origin, 'Content-Type': 'application/json' };
      const state = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      assert.equal(state.networkMode, 'providers');
      assert.equal(
        state.providers.some((p) => p.hasKey),
        false,
      );
      const input = {
        roles: state.roles,
        imageModels: state.imageModels,
        keys: { openai: 'fixture-openai-key', anthropic: 'fixture-anthropic-key' },
      };
      const save = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(save.status, 200, JSON.stringify(await save.clone().json()));
      const configText = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
      assert.doesNotMatch(configText, /fixture-openai-key|fixture-anthropic-key/);
      const configured = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      assert.ok(configured.providers.every((p) => p.hasKey));
      assert.doesNotMatch(JSON.stringify(configured), /fixture-openai-key|fixture-anthropic-key/);
      const models = await (await fetch(stack.origin + '/site/api/models', { headers })).json();
      assert.ok(models.providers.every((p) => p.error === null && p.count > 0));
      assert.equal(models.issues.length, 0);
      const blank = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, keys: { openai: '', anthropic: '' } }),
      });
      assert.equal(blank.status, 200);
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), configText);
      const invalid = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, keys: { openai: 'bad-fixture-key' } }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), configText);
    } finally {
      await stack.close();
    }
  },
);
test('AI-33: UI loads models then submits and retains encrypted keys after reload', { timeout: 240000 }, async () => {
  const { chromium } = await import('playwright');
  const stack = await isolatedStack({
    networkMode: 'providers',
    controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
  });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(stack.origin + '/login');
    await page.locator('input[name=password]').fill(stack.password);
    await page.locator('button').click();
    await page.waitForURL('**/content/');
    studio = await studioFrame(page, 'content');
    await page.goto(stack.origin + '/site/');
    studio = await studioFrame(page, 'site');
    await studio.locator('#workspace').waitFor({ state: 'visible' });
    await studio.locator('#settings').waitFor({ state: 'visible' });
    await studio.locator('#key-openai').fill('fixture-openai-key');
    await studio.locator('#key-anthropic').fill('fixture-anthropic-key');
    const catalog = page.waitForResponse(
      (r) => r.url().endsWith('/site/api/models') && r.request().method() === 'POST',
    );
    await studio.locator('#check-models').click();
    assert.equal((await catalog).status(), 200);
    assert.equal(await studio.locator('#key-openai').inputValue(), 'fixture-openai-key');
    assert.equal(await studio.locator('#key-anthropic').inputValue(), 'fixture-anthropic-key');
    const save = page.waitForResponse((r) => r.url().endsWith('/site/api/settings') && r.request().method() === 'POST');
    await studio.locator('#settings-form button[type=submit]').click();
    const response = await save;
    assert.equal(response.status(), 200, JSON.stringify(await response.json()));
    await studio.locator('#settings').waitFor({ state: 'hidden' });
    const text = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
    assert.doesNotMatch(text, /fixture-openai-key|fixture-anthropic-key/);
    await page.reload();
    studio = await studioFrame(page, 'site');
    await studio.locator('#workspace').waitFor({ state: 'visible' });
    const state = await studio.evaluate(async () => await (await fetch('/site/api/state')).json());
    assert.ok(state.providers.every((p) => p.hasKey));
    await openAiSettings(studio);
    await studio.locator('#settings').waitFor({ state: 'visible' });
    assert.equal(await studio.locator('#key-openai').inputValue(), '');
    assert.equal(await studio.locator('#key-anthropic').inputValue(), '');
    const retained = page.waitForResponse(
      (r) => r.url().endsWith('/site/api/settings') && r.request().method() === 'POST',
    );
    await studio.locator('#settings-form button[type=submit]').click();
    assert.equal((await retained).status(), 200);
    assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), text);
  } finally {
    await browser?.close();
    await stack.close();
  }
});
test('AI-33: delayed startup/open catalog preserves typed keys and role edits before save', { timeout: 240000 }, async () => {
  const { chromium } = await import('playwright');
  const stack = await isolatedStack({
    networkMode: 'providers',
    controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
  });
  let browser;
  let release;
  const held = new Promise((r) => (release = r));
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    let getCount = 0;
    await page.route('**/site/api/models', async (route) => {
      if (route.request().method() === 'GET') {
        getCount++;
        await held;
        await route.continue();
      } else await route.continue();
    });
    await page.goto(stack.origin + '/login');
    await page.locator('input[name=password]').fill(stack.password);
    await page.locator('button').click();
    await page.waitForURL('**/content/');
    studio = await studioFrame(page, 'content');
    await page.goto(stack.origin + '/site/');
    studio = await studioFrame(page, 'site');
    await studio.locator('#workspace').waitFor({ state: 'visible' });
    await openAiSettings(studio);
    await studio.locator('#settings').waitFor({ state: 'visible' });
    await studio.locator('#key-openai').fill('fixture-openai-key');
    await studio.locator('#key-anthropic').fill('fixture-anthropic-key');
    await studio.locator('#effort-ui').selectOption('high');
    release();
    await studio.waitForFunction(() => document.getElementById('effort-ui').value === 'high');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(getCount >= 2);
    assert.equal(await studio.locator('#key-openai').inputValue(), 'fixture-openai-key');
    assert.equal(await studio.locator('#key-anthropic').inputValue(), 'fixture-anthropic-key');
    assert.equal(await studio.locator('#effort-ui').inputValue(), 'high');
    const list = page.waitForResponse((r) => r.url().endsWith('/site/api/models') && r.request().method() === 'POST');
    await studio.locator('#check-models').click();
    assert.equal((await list).status(), 200);
    assert.equal(await studio.locator('#effort-ui').inputValue(), 'high');
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/site/api/settings') && r.request().method() === 'POST',
    );
    await studio.locator('#settings-form button[type=submit]').click();
    assert.equal((await pending).status(), 200);
    await studio.locator('#settings').waitFor({ state: 'hidden' });
    const state = await studio.evaluate(async () => await (await fetch('/site/api/state')).json());
    assert.ok(state.providers.every((p) => p.hasKey));
    assert.equal(state.roles.ui.reasoningEffort, 'high');
    const raw = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
    assert.doesNotMatch(raw, /fixture-openai-key|fixture-anthropic-key/);
  } finally {
    release();
    await browser?.close();
    await stack.close();
  }
});
