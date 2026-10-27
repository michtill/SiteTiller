import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog } from '../apps/aistudio/src/catalog.ts';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { detectProvider } from '../packages/providers/index.mjs';
import { fixtureKeys } from './fixtures/provider-catalog-mock.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser, studioFrame } from './support/browser.mjs';
const keyPattern = new RegExp(Object.values(fixtureKeys).join('|'));
test('OP-05: provider mode allows only intended APIs; fixture offline remains explicit', () => {
  assert.equal(allowedNetworkURL('offline', 'https://api.openai.com/v1/models'), false);
  assert.equal(allowedNetworkURL('providers', 'https://api.openai.com/v1/models'), true);
  assert.equal(allowedNetworkURL('providers', 'https://api.anthropic.com/v1/models'), true);
  assert.equal(allowedNetworkURL('providers', 'https://generativelanguage.googleapis.com/v1beta/models'), true);
  assert.equal(allowedNetworkURL('offline', 'https://generativelanguage.googleapis.com/v1beta/models'), false);
  for (const url of [
    'https://example.com/',
    'http://api.openai.com/v1/models',
    'https://api.openai.com:444/v1/models',
    'https://api.openai.com.other/v1/models',
    'https://api.openai.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1/models',
    'https://generativelanguage.googleapis.com.other/v1beta/models',
  ])
    assert.equal(allowedNetworkURL('providers', url), false, url);
  assert.equal(allowedNetworkURL('offline', 'http://127.0.0.1:4510/api/bootstrap'), true);
});
test('AI-33: the provider is told by the key shape only; unknown and admin keys are refused', () => {
  assert.deepEqual(detectProvider(fixtureKeys.anthropic), { provider: 'anthropic' });
  assert.deepEqual(detectProvider(fixtureKeys.openai), { provider: 'openai' });
  assert.deepEqual(detectProvider('sk-' + 'a'.repeat(48)), { provider: 'openai' });
  assert.deepEqual(detectProvider('sk-svcacct-' + 'b'.repeat(40)), { provider: 'openai' });
  assert.deepEqual(detectProvider(fixtureKeys.gemini), { provider: 'gemini' });
  // Gemini's newer auth key from AI Studio.
  assert.deepEqual(detectProvider(fixtureKeys.geminiAuth), { provider: 'gemini' });
  assert.deepEqual(detectProvider('sk-admin-' + 'c'.repeat(40)), { problem: 'admin' });
  for (const value of [
    '',
    'hello',
    'AIza-too-short',
    'AQ.short',
    'AQ ' + 'e'.repeat(40),
    'xai-' + 'd'.repeat(40),
    'sk-short',
  ])
    assert.deepEqual(detectProvider(value), { problem: 'unknown' }, value);
});
test('AI-33: catalog errors distinguish offline/network/auth/access/quota/rate without leaking bodies', async () => {
  for (const [status, code, kind] of [
    [401, 'invalid_api_key', 'authentication'],
    [403, 'permission_denied', 'access'],
    [429, 'insufficient_quota', 'quota'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [503, 'unknown', 'provider'],
  ]) {
    const result = await catalog({ openai: fixtureKeys.openai, anthropic: '', gemini: '' }, async () =>
      Response.json({ error: { code, message: 'must-not-leak-fixture-secret' } }, { status }),
    );
    assert.equal(result.providers[0].errorKind, kind);
    assert.equal(result.providers[0].httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result), new RegExp('must-not-leak|' + fixtureKeys.openai));
  }
  const blocked = await catalog({ openai: 'fixture', anthropic: '', gemini: '' }, async () => {
    throw Object.assign(Error('blocked'), { code: 'ERR_SITETILLER_NETWORK_BLOCKED', networkMode: 'offline' });
  });
  assert.equal(blocked.providers[0].errorKind, 'blocked_network');
  const network = await catalog({ openai: 'fixture', anthropic: '', gemini: '' }, async () => {
    throw Error('ECONNRESET private body');
  });
  assert.equal(network.providers[0].errorKind, 'network');
  assert.doesNotMatch(JSON.stringify(network), /private body/);
  // Gemini: the key in its header, pages followed, only text models that answer generateContent; preview marked.
  const seen = [];
  const gemini = await catalog({ openai: '', anthropic: '', gemini: fixtureKeys.gemini }, async (url, options) => {
    seen.push({ url: String(url), key: new Headers(options.headers).get('x-goog-api-key') });
    return String(url).includes('pageToken=next')
      ? Response.json({
          models: [
            {
              name: 'models/gemini-3-pro-preview',
              displayName: 'Gemini 3 Pro',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        })
      : Response.json({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Embedding',
              supportedGenerationMethods: ['embedContent'],
            },
            {
              name: 'models/gemini-2.5-flash-preview-tts',
              displayName: 'TTS',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
          nextPageToken: 'next',
        });
  });
  const listed = gemini.providers.find((p) => p.provider === 'gemini');
  assert.equal(listed.error, null);
  assert.ok(seen.every((call) => call.key === fixtureKeys.gemini && !call.url.includes(fixtureKeys.gemini)));
  assert.deepEqual(
    gemini.models.filter((m) => m.provider === 'gemini' && m.usable).map((m) => [m.id, m.name]),
    [
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-3-pro-preview', 'Gemini 3 Pro (preview)'],
    ],
  );
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
        keys: { openai: fixtureKeys.openai, anthropic: fixtureKeys.anthropic },
      };
      const save = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(save.status, 200, JSON.stringify(await save.clone().json()));
      // A Gemini key: checked with Google's model list only, then saved encrypted.
      const add = (provider, key) =>
        fetch(stack.origin + '/site/api/keys/add', {
          method: 'POST',
          headers,
          body: JSON.stringify({ provider, key }),
        });
      assert.equal((await add('gemini', fixtureKeys.gemini)).status, 200);
      // The auth key "AQ.…" is checked the same way, with the key in the x-goog-api-key header.
      assert.equal((await add('gemini', fixtureKeys.geminiAuth)).status, 200);
      const refused = await add('gemini', 'AIza' + 'X'.repeat(35));
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).error, /Klíč se neuložil: chybí přístup k API nebo modelům \(HTTP 403\)/);
      // A key whose shape names another provider is refused before any call.
      assert.equal((await add('openai', fixtureKeys.gemini)).status, 422);
      const configText = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
      assert.doesNotMatch(configText, keyPattern);
      const configured = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      assert.ok(configured.providers.every((p) => p.hasKey));
      assert.doesNotMatch(JSON.stringify(configured), keyPattern);
      const models = await (await fetch(stack.origin + '/site/api/models', { headers })).json();
      assert.ok(models.providers.every((p) => p.error === null && p.count > 0));
      assert.ok(models.models.some((m) => m.provider === 'gemini' && m.id === 'gemini-2.5-pro' && m.usable));
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
        body: JSON.stringify({ ...input, keys: { openai: 'sk-proj-badFixtureKey000000000000' } }),
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
  await page.waitForURL((url) => url.pathname === '/');
}
async function addKey(page, value) {
  await page.locator('input[name=key]').fill(value);
  await page.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
}
test(
  'AI-33: one key field tells the provider, saves the key encrypted and never shows it, refuses an unknown or rejected key, replaces a key after the app confirm dialog and removes one',
  { timeout: 240000 },
  async () => {
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
      let settings = await studioFrame(page, 'settings');
      await addKey(settings, fixtureKeys.openai);
      await settings.getByText('Klíč OpenAI je uložený.', { exact: true }).waitFor();
      await addKey(settings, fixtureKeys.anthropic);
      await settings.getByText('Klíč Anthropic je uložený.', { exact: true }).waitFor();
      await addKey(settings, fixtureKeys.gemini);
      await settings.getByText('Klíč Google Gemini je uložený.', { exact: true }).waitFor();
      // The table names the providers only; the keys are never sent back to the browser.
      assert.deepEqual(await settings.locator('.keys-table .key-provider').allTextContents(), [
        'OpenAI',
        'Anthropic',
        'Google Gemini',
      ]);
      assert.equal(await settings.locator('input[name=key]').inputValue(), '');
      // The key is not a sign-in password: no password field, so the browser does not offer to save it; the
      // characters are hidden until the eye shows them.
      const field = settings.locator('input[name=key]');
      assert.deepEqual(await field.evaluate((i) => [i.type, i.autocomplete, getComputedStyle(i).webkitTextSecurity]), [
        'text',
        'off',
        'disc',
      ]);
      await settings.locator('.key-add .show-password').click();
      assert.equal(await field.evaluate((i) => getComputedStyle(i).webkitTextSecurity), 'none');
      await settings.locator('.key-add .show-password').click();
      assert.equal(await settings.locator('input[type=password]').count(), 0);
      assert.doesNotMatch(await settings.content(), keyPattern);
      const text = await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8');
      assert.doesNotMatch(text, keyPattern);
      // Gemini models are offered for the team roles as provider · model, without Gemini twice.
      await settings.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      assert.ok(
        (await settings.locator('select[name=role_primary] option').allTextContents()).includes(
          'Google · Gemini 2.5 Pro',
        ),
      );
      // Unknown and admin keys are refused with the reason under the field; nothing is saved.
      await addKey(settings, 'hello-not-a-key');
      await settings
        .getByText('Tento klíč aplikace nepoznává. Podporuje klíče OpenAI, Anthropic a Google Gemini.', { exact: true })
        .waitFor();
      await addKey(settings, 'sk-admin-' + 'c'.repeat(40));
      await settings.getByText(/správcovský klíč OpenAI/).waitFor();
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), text);
      // Another key of a saved provider: the app's confirm dialog; Cancel keeps the saved key.
      await addKey(settings, 'sk-proj-badFixtureKey000000000000');
      const dialog = settings.getByRole('dialog', { name: 'Potvrdit akci' });
      await dialog.getByText('Nahradit uložený klíč OpenAI?').waitFor();
      await dialog.getByRole('button', { name: 'Zrušit' }).click();
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), text);
      // Confirm: the provider refuses it, so it is not saved and the saved key stays.
      await settings.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
      await dialog.getByRole('button', { name: 'Potvrdit' }).click();
      await settings.getByText('Klíč se neuložil: klíč nebyl přijat (HTTP 401).', { exact: true }).waitFor();
      assert.equal(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), text);
      // Saving the team keeps the saved keys.
      await settings.getByRole('button', { name: 'Uložit', exact: true }).click();
      await settings.getByText('Uloženo', { exact: true }).waitFor();
      assert.ok(
        (await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.every((p) => p.hasKey),
      );
      // Remove key asks first, then removes the key even though the team uses it; without keys the status says so.
      for (const provider of ['openai', 'anthropic', 'gemini']) {
        await settings.locator('button[value=remove_' + provider + ']').click();
        await dialog.getByText(/Opravdu odebrat klíč/).waitFor();
        await dialog.getByRole('button', { name: 'Zrušit' }).click();
        assert.equal(await dialog.count(), 0);
        assert.ok(
          (await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.find(
            (p) => p.provider === provider,
          ).hasKey,
        );
        await settings.locator('button[value=remove_' + provider + ']').click();
        await dialog.getByRole('button', { name: 'Potvrdit' }).click();
        // The page reloads in the Settings frame; the note of the previous removal must not count.
        await settings.locator('button[value=remove_' + provider + ']').waitFor({ state: 'detached' });
        await settings.getByText('Klíč je odebraný.', { exact: true }).waitFor();
      }
      assert.ok(
        (await (await page.request.get(stack.origin + '/site/api/state')).json()).providers.every((p) => !p.hasKey),
      );
      assert.match(await settings.locator('#model-catalog').textContent(), /nejsou zadané žádné API klíče/);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
test(
  'AI-33: AI models save team choices with one Save; the lists arrive after the page',
  { timeout: 240000 },
  async () => {
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
      let settings = await studioFrame(page, 'settings');
      await addKey(settings, fixtureKeys.openai);
      await settings.getByText('Klíč OpenAI je uložený.', { exact: true }).waitFor();
      await addKey(settings, fixtureKeys.anthropic);
      await settings.getByText('Klíč Anthropic je uložený.', { exact: true }).waitFor();
      await settings.locator('select[name=effort_ui]').selectOption('high');
      await settings.getByRole('button', { name: 'Uložit', exact: true }).click();
      await settings.getByText('Uloženo', { exact: true }).waitFor();
      assert.equal(await settings.locator('select[name=effort_ui]').inputValue(), 'high');
      const state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.ok(state.providers.filter((p) => p.provider !== 'gemini').every((p) => p.hasKey));
      assert.equal(state.roles.ui.reasoningEffort, 'high');
      assert.doesNotMatch(await readFile(join(stack.root, '.sitetiller/config.json'), 'utf8'), keyPattern);
      // The page comes at once with the saved choices and a loading note; the providers' lists follow and fill the
      // selects while the chosen values stay selected.
      const html = await (await page.request.get(stack.origin + '/settings/aiapi')).text();
      assert.match(html, /Načítám seznam modelů/);
      const catalog = await (await page.request.get(stack.origin + '/settings/aiapi/catalog')).json();
      assert.ok(catalog.roles.every((role) => role.options.length > 1));
      await page.goto(stack.origin + '/settings/aiapi');
      settings = await studioFrame(page, 'settings');
      await settings.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      assert.ok((await settings.locator('select[name=role_primary] option').count()) > 1);
      assert.equal(await settings.locator('select[name=effort_ui]').inputValue(), 'high');
      assert.equal(
        await settings.locator('select[name=role_primary]').inputValue(),
        state.roles.primary.provider + '|' + state.roles.primary.model,
      );
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);

test(
  'UX-01: the AI Studio models page keeps every field in place while the model lists arrive',
  { timeout: 240000 },
  async () => {
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
      await page.route('**/settings/aiapi/catalog?*', async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(stack.origin + '/settings/aiapi');
      let settings = await studioFrame(page, 'settings');
      const places = () =>
        settings.evaluate(() =>
          ['select[name=role_primary]', 'select[name=image_fast]', '#team-save'].map(
            (selector) => document.querySelector(selector).getBoundingClientRect().top,
          ),
        );
      const before = await places();
      // Without keys the status line says so in the place of the Save and load models button.
      assert.match(await settings.locator('#model-catalog').textContent(), /nejsou zadané žádné API klíče/);
      const arrived = page.waitForResponse('**/settings/aiapi/catalog?*');
      release();
      await arrived;
      await page.waitForTimeout(100);
      assert.deepEqual(await places(), before);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
