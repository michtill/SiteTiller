import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog } from '../apps/aistudio/src/catalog.ts';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser } from './support/browser.mjs';
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
      // A key the provider refuses is not saved, even when no team model uses it; the saved one stays.
      assert.equal(invalid.status, 200);
      const invalidBody = await invalid.json();
      assert.match(invalidBody.rejectedKeys.openai, /klíč nebyl přijat \(HTTP 401\)/);
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), configText);
    } finally {
      await stack.close();
    }
  },
);
// AI models are a settings screen of the Shell (documentation 2.4, /settings/aiapi).
async function signIn(page, stack) {
  await page.goto(stack.origin + '/login');
  await page.locator('input[name=password]').fill(stack.password);
  await page.locator('button:not(.show-password)').click();
  await page.waitForURL('**/content/');
}
test('AI-33: AI models save keys encrypted, never show them again, refuse a key the provider rejects, keep them when the fields stay empty and remove one after the app confirm dialog', { timeout: 240000 }, async () => {
  const stack = await isolatedStack({
    networkMode: 'providers',
    controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
  });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await signIn(page, stack);
    await page.goto(stack.origin + '/settings/aiapi?returnTo=%2Fsite%2F');
    const load = page.getByRole('button', { name: 'Uložit a načíst modely', exact: true });
    // Save and load models appears only once a new key is typed in.
    assert.equal(await load.isVisible(), false);
    await page.locator('input[name=key_openai]').fill('fixture-openai-key');
    await page.locator('input[name=key_anthropic]').fill('fixture-anthropic-key');
    assert.equal(await load.isVisible(), true);
    await load.click();
    await page.getByText('Klíče jsou uložené a seznam modelů je načtený.', { exact: true }).waitFor();
    // The keys are never sent back to the browser.
    assert.equal(await page.locator('input[name=key_openai]').inputValue(), '');
    assert.doesNotMatch(await page.content(), /fixture-openai-key|fixture-anthropic-key/);
    assert.ok((await page.locator('select[name=role_primary] option').count()) > 0);
    const text = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
    assert.doesNotMatch(text, /fixture-openai-key|fixture-anthropic-key/);
    const state = await (await page.request.get(stack.origin + '/site/api/state')).json();
    assert.ok(state.providers.every((p) => p.hasKey));
    // A refused key is not saved: the reason is under its field and the status is red.
    await page.locator('input[name=key_openai]').fill('bad-fixture-key');
    await load.click();
    await page.getByText('Klíč se neuložil: klíč nebyl přijat (HTTP 401).', { exact: true }).waitFor();
    assert.equal(await page.locator('#model-catalog').getAttribute('data-state'), 'failed');
    assert.equal(await page.locator('#key-note-anthropic').textContent(), 'Klíč je uložený šifrovaně.');
    assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), text);
    // Saving with empty key fields keeps the saved keys.
    await page.getByRole('button', { name: 'Uložit', exact: true }).click();
    await page.getByText('Uloženo', { exact: true }).waitFor();
    assert.ok((await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.every((p) => p.hasKey));
    // Remove key asks first, then removes the key even though the team uses it; without keys the status says so.
    for (const provider of ['openai', 'anthropic']) {
      // The app's confirm dialog: Cancel keeps the key, Confirm removes it.
      await page.locator('button[value=remove_' + provider + ']').click();
      const dialog = page.getByRole('dialog', { name: 'Potvrdit akci' });
      await dialog.getByText(/Opravdu odebrat klíč/).waitFor();
      await dialog.getByRole('button', { name: 'Zrušit' }).click();
      assert.equal(await dialog.count(), 0);
      assert.ok((await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.find((p) => p.provider === provider).hasKey);
      await page.locator('button[value=remove_' + provider + ']').click();
      await dialog.getByRole('button', { name: 'Potvrdit' }).click();
      await page.getByText('Klíč je odebraný.', { exact: true }).waitFor();
      assert.equal(await page.locator('#key-note-' + provider).textContent(), 'Klíč zatím není uložený.');
    }
    assert.ok((await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.every((p) => !p.hasKey));
    assert.match(await page.locator('#model-catalog').textContent(), /nejsou zadané žádné API klíče/);
  } finally {
    await browser?.close();
    await stack.close();
  }
});
test('AI-33: AI models save new keys and team choices together with one Save', { timeout: 240000 }, async () => {
  const stack = await isolatedStack({
    networkMode: 'providers',
    controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
  });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await signIn(page, stack);
    await page.goto(stack.origin + '/settings/aiapi');
    await page.locator('input[name=key_openai]').fill('fixture-openai-key');
    await page.locator('input[name=key_anthropic]').fill('fixture-anthropic-key');
    await page.locator('select[name=effort_ui]').selectOption('high');
    await page.getByRole('button', { name: 'Uložit', exact: true }).click();
    await page.getByText('Uloženo', { exact: true }).waitFor();
    assert.equal(await page.locator('select[name=effort_ui]').inputValue(), 'high');
    const state = await (await page.request.get(stack.origin + '/site/api/state')).json();
    assert.ok(state.providers.every((p) => p.hasKey));
    assert.equal(state.roles.ui.reasoningEffort, 'high');
    assert.doesNotMatch(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), /fixture-openai-key|fixture-anthropic-key/);
    // The page comes at once with the saved choices and a loading note; the providers' lists follow and fill the
    // selects while the chosen values stay selected.
    const html = await (await page.request.get(stack.origin + '/settings/aiapi')).text();
    assert.match(html, /Načítám seznam modelů/);
    const catalog = await (await page.request.get(stack.origin + '/settings/aiapi/catalog')).json();
    assert.ok(catalog.roles.every((role) => role.options.length > 1));
    await page.goto(stack.origin + '/settings/aiapi');
    await page.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
    assert.ok((await page.locator('select[name=role_primary] option').count()) > 1);
    assert.equal(await page.locator('select[name=effort_ui]').inputValue(), 'high');
    assert.equal(
      await page.locator('select[name=role_primary]').inputValue(),
      state.roles.primary.provider + '|' + state.roles.primary.model,
    );
  } finally {
    await browser?.close();
    await stack.close();
  }
});

test('UX-01: the AI Studio models page keeps every field in place while the model lists arrive', { timeout: 240000 }, async () => {
  const stack = await isolatedStack({
    networkMode: 'providers',
    controllerImports: ['test/fixtures/provider-catalog-mock.mjs'],
  });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30000);
    await signIn(page, stack);
    // The lists arrive only when the test lets them, so the place of the fields can be measured before and after.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/settings/aiapi/catalog', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(stack.origin + '/settings/aiapi');
    const places = () =>
      page.evaluate(() =>
        ['select[name=role_primary]', 'select[name=image_fast]', 'button:not([value])'].map(
          (selector) => document.querySelector(selector).getBoundingClientRect().top,
        ),
      );
    const before = await places();
    // Without keys the status line says so in the place of the Save and load models button.
    assert.match(await page.locator('#model-catalog').textContent(), /nejsou zadané žádné API klíče/);
    const arrived = page.waitForResponse('**/settings/aiapi/catalog');
    release();
    await arrived;
    await page.waitForTimeout(100);
    assert.deepEqual(await places(), before);
  } finally {
    await browser?.close();
    await stack.close();
  }
});
