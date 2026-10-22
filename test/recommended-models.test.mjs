import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recommendedUrl,
  validRecommendation,
  validImageRecommendation,
  recommendedImageTools,
  recommendedImagesUrl,
  parseRecommendation,
  recommendedTeam,
} from '../packages/models/index.mjs';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { fixtureKeys } from './fixtures/provider-catalog-mock.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser } from './support/browser.mjs';
// Recommended models (documentation 4.6).
const bundled = JSON.parse(await readFile(new URL('../packages/models/recommended.json', import.meta.url), 'utf8'));
const bundledImages = JSON.parse(
  await readFile(new URL('../packages/models/recommended-images.json', import.meta.url), 'utf8'),
);
test('AI-35: the recommended models file is data only; anything outside its shape refuses the whole file', () => {
  assert.equal(validRecommendation(bundled), true);
  const broken = [
    { ...bundled, extra: 1 },
    { ...bundled, version: 2 },
    { ...bundled, date: 'tomorrow' },
    { ...bundled, roles: { ...bundled.roles, images: [] } },
    { ...bundled, roles: { ...bundled.roles, ui: [] } },
    { ...bundled, roles: { ...bundled.roles, ui: [{ provider: 'xai', model: 'grok' }] } },
    { ...bundled, roles: { ...bundled.roles, ui: [{ provider: 'openai', model: 'gpt-6 && rm -rf /' }] } },
    { ...bundled, roles: { ...bundled.roles, ui: [{ provider: 'openai', model: 'gpt-6', run: 'code' }] } },
    { ...bundled, roles: { ...bundled.roles, ui: [{ provider: 'openai', model: 'gpt-6', effort: 'max' }] } },
  ];
  for (const value of broken) assert.equal(validRecommendation(value), false, JSON.stringify(value).slice(0, 120));
  assert.equal(parseRecommendation('{not json'), null);
  assert.equal(parseRecommendation(JSON.stringify(bundled) + ' '.repeat(70000)), null);
});
test('AI-35: each role gets the first recommended model with a key and in the catalog; otherwise it stays', () => {
  const current = {
    primary: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    ui: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    verify: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    escalation: { provider: 'openai', model: 'old', reasoningEffort: 'high' },
  };
  const recommendation = {
    version: 1,
    date: '2026-10-21',
    roles: {
      primary: [
        { provider: 'gemini', model: 'gemini-2.5-pro' },
        { provider: 'openai', model: 'gpt-gone' },
        { provider: 'openai', model: 'gpt-here' },
      ],
      ui: [{ provider: 'anthropic', model: 'claude-x' }],
      verify: [{ provider: 'openai', model: 'gpt-gone' }],
      escalation: [{ provider: 'openai', model: 'gpt-here', effort: 'high' }],
    },
  };
  const models = [
    { provider: 'openai', id: 'gpt-here', usable: true },
    { provider: 'anthropic', id: 'claude-x', usable: true },
    { provider: 'gemini', id: 'gemini-2.5-pro', usable: true },
  ];
  const team = recommendedTeam(recommendation, models, { openai: 'k', anthropic: '', gemini: '' }, current);
  // Gemini without a key, gpt-gone not in the catalog: the next one.
  assert.deepEqual(team.primary, { provider: 'openai', model: 'gpt-here', reasoningEffort: 'auto' });
  // No Anthropic key and nothing else recommended: the role stays.
  assert.deepEqual(team.ui, current.ui);
  assert.deepEqual(team.verify, current.verify);
  assert.deepEqual(team.escalation, { provider: 'openai', model: 'gpt-here', reasoningEffort: 'high' });
  assert.deepEqual(
    recommendedTeam(recommendation, models, { openai: 'k', anthropic: 'k', gemini: 'k' }, current).primary,
    { provider: 'gemini', model: 'gemini-2.5-pro', reasoningEffort: 'auto' },
  );
});
test('AI-35: the image tools have their own recommendation file with its own strict shape', () => {
  assert.equal(validImageRecommendation(bundledImages), true);
  // Google's Nano Banana models have no "image" in their id and are image models too.
  assert.equal(
    validImageRecommendation({
      ...bundledImages,
      images: { ...bundledImages.images, fast: [{ provider: 'gemini', model: 'gemini-nano-banana-2.1' }] },
    }),
    true,
  );
  for (const value of [
    { ...bundledImages, roles: {} },
    { ...bundledImages, images: { ...bundledImages.images, other: [] } },
    {
      ...bundledImages,
      images: { ...bundledImages.images, fast: [{ provider: 'gemini', model: 'gemini-3.8-flash' }] },
    },
    {
      ...bundledImages,
      images: { ...bundledImages.images, fast: [{ provider: 'openai', model: 'gemini-3-pro-image' }] },
    },
  ])
    assert.equal(validImageRecommendation(value), false);
  const models = [
    { provider: 'gemini', id: 'gemini-3-pro-image' },
    { provider: 'openai', id: 'gpt-image-2.5-flare' },
  ];
  // No OpenAI key: Gemini for the precise tool; the fast tool has OpenAI first but no key and no Gemini fast model: stays.
  assert.deepEqual(
    recommendedImageTools(
      bundledImages,
      models,
      { openai: '', anthropic: '', gemini: 'k' },
      { precise: 'none', fast: 'none' },
    ),
    { precise: 'gemini-3-pro-image', fast: 'none' },
  );
});
test('AI-35: only the one GitHub address of the file, and only in the providers mode', () => {
  assert.equal(allowedNetworkURL('providers', recommendedUrl), true);
  assert.equal(allowedNetworkURL('providers', recommendedImagesUrl), true);
  assert.equal(allowedNetworkURL('offline', recommendedImagesUrl), false);
  assert.equal(allowedNetworkURL('offline', recommendedUrl), false);
  for (const url of [
    recommendedUrl.replace('/main/', '/other/'),
    recommendedUrl + '?x=1',
    'https://raw.githubusercontent.com/michtill/SiteTiller-advice/main/README.md',
    // The application's own repository is not read any more: a release would overwrite the file there.
    'https://raw.githubusercontent.com/michtill/SiteTiller/main/packages/models/recommended.json',
    recommendedUrl.replace('/v1.json', '/v2.json'),
  ])
    assert.equal(allowedNetworkURL('providers', url), false, url);
});
test(
  'AI-35: the Recommended team tab follows the newer GitHub file and the keys; the own team comes back as it was; the team in use is marked',
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
      await page.goto(stack.origin + '/login');
      await page.locator('input[name=password]').fill(stack.password);
      await page.locator('button:not(.show-password)').click();
      await page.waitForURL('**/content/');
      await page.goto(stack.origin + '/settings/aiapi');
      // Wait for each provider's own notice: the previous one may still be on the page.
      for (const [key, name] of [
        [fixtureKeys.openai, 'OpenAI'],
        [fixtureKeys.anthropic, 'Anthropic'],
      ]) {
        await page.locator('input[name=key]').fill(key);
        await page.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
        await page.getByText('Klíč ' + name + ' je uložený.', { exact: true }).waitFor();
      }
      // The own team by default; it is saved with a choice of the user's own.
      const recommended = page.getByRole('button', { name: 'Doporučený tým', exact: true }),
        own = page.getByRole('button', { name: 'Vlastní tým', exact: true });
      assert.equal(await own.getAttribute('aria-pressed'), 'true');
      await page.getByText('Používáte vlastní tým.', { exact: true }).waitFor();
      await page.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      await page.locator('select[name=image_fast]').selectOption('none');
      await page.getByRole('button', { name: 'Uložit', exact: true }).click();
      await page.getByText('Uloženo', { exact: true }).waitFor();
      const ownTeam = await (await page.request.get(stack.origin + '/site/api/state')).json();
      // One click on the tab switches and saves in place: no new page, the scroll position stays; the choices are
      // read only and Save is gone.
      await page.evaluate(() => {
        window.samePage = true;
        window.scrollTo(0, 200);
      });
      const scrolled = await page.evaluate(() => window.scrollY);
      await recommended.click();
      assert.equal(await recommended.getAttribute('aria-pressed'), 'true');
      await page.getByText('Doporučení GitHub 2099-01-01', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => [window.samePage, window.scrollY]), [true, scrolled]);
      assert.equal(await page.locator('select[name=role_primary]').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Uložit', exact: true }).isVisible(), false);
      let state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.equal(state.autoTeam, true);
      // The GitHub file is newer than the shipped one, so it wins; Gemini has no key and gpt-6-sol is not in the
      // catalog, so the Web Lead stays; the others follow the file.
      assert.deepEqual(state.recommendation, { date: '2099-01-01', source: 'online' });
      assert.deepEqual(state.roles.primary, { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'auto' });
      assert.deepEqual(state.roles.ui, { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'auto' });
      // The image tools follow the shipped image recommendation (none on GitHub here); their selects are read only.
      assert.deepEqual(state.imageModels, { precise: 'gpt-image-2.5-sunburst', fast: 'gpt-image-2.5-flare' });
      assert.equal(await page.locator('select[name=image_fast]').isDisabled(), true);
      // A Gemini key: the Web Lead becomes Gemini at the next catalog load.
      await page.locator('input[name=key]').fill(fixtureKeys.gemini);
      await page.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
      await page.getByText('Klíč Google Gemini je uložený.', { exact: true }).waitFor();
      await page.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.deepEqual(state.roles.primary, { provider: 'gemini', model: 'gemini-2.5-pro', reasoningEffort: 'auto' });
      assert.equal(await page.locator('select[name=role_primary]').inputValue(), 'gemini|gemini-2.5-pro');
      // Update checks GitHub at once and sets the team by it.
      await page.getByRole('button', { name: 'Aktualizovat', exact: true }).click();
      await page.locator('.team-status:not([data-busy])').waitFor();
      assert.equal(
        await page.locator('.team-status span').textContent(),
        'Doporučení GitHub 2099-01-01',
      );
      assert.deepEqual((await (await page.request.get(stack.origin + '/site/api/state')).json()).roles, state.roles);
      // The OpenAI key goes: the own team's Web Lead (OpenAI) has no key now.
      await page.request.post(stack.origin + '/settings/aiapi', {
        headers: { Origin: stack.origin },
        form: { action: 'remove_openai_yes', returnTo: '/site/' },
      });
      // Back to the own team: the switch succeeds anyway (that is where the Web Lead is fixed); it returns as it was,
      // editable, and the missing key is said once under Save.
      await own.click();
      await page.getByText('Používáte vlastní tým.', { exact: true }).waitFor();
      state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.equal(state.autoTeam, false);
      assert.deepEqual([state.roles, state.imageModels], [ownTeam.roles, ownTeam.imageModels]);
      assert.equal(await page.locator('select[name=role_primary]').isDisabled(), false);
      const alert = await page.locator('#model-alerts').textContent();
      assert.match(alert, /Web Lead/);
      assert.equal(alert.split('Web Lead').length, 2, alert);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
test('AI-35: offline nothing is downloaded and the shipped recommendation applies', { timeout: 120000 }, async () => {
  const stack = await isolatedStack({ controllerImports: ['test/fixtures/provider-catalog-mock.mjs'] });
  try {
    const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      headers = {
        Cookie: login.headers.get('set-cookie').split(';')[0],
        Origin: stack.origin,
        'Content-Type': 'application/json',
      };
    const state = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
    assert.equal(state.networkMode, 'offline');
    const saved = await fetch(stack.origin + '/site/api/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ roles: state.roles, imageModels: state.imageModels, autoTeam: true }),
    });
    // Offline the catalog cannot confirm the Web Lead: the usual unavailability error, nothing downloaded.
    assert.equal(saved.status, 400);
    const after = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
    assert.deepEqual(after.recommendation, { date: bundled.date, source: 'bundled' });
    await assert.rejects(access(join(stack.root, '.sitetiller/recommended-online.json')));
  } finally {
    await stack.close();
  }
});
test('AI-35: a release bundles the published recommendations by script; an invalid or older file writes nothing', async () => {
  const { bundleAdvice } = await import('../scripts/bundle-advice.mjs');
  const { mkdtemp, mkdir, writeFile: write, readFile: read, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const base = await mkdtemp(join(tmpdir(), 'bundle-advice-'));
  try {
    await mkdir(join(base, 'packages/models'), { recursive: true });
    const bundledText = JSON.stringify(bundled) + '\n';
    await write(join(base, 'packages/models/recommended.json'), bundledText);
    await write(join(base, 'packages/models/recommended-images.json'), JSON.stringify(bundledImages) + '\n');
    const root = pathToFileURL(base + '/');
    const newer = JSON.stringify({ ...bundled, date: '2099-01-02' }, null, 2) + '\n';
    const serve = (texts) => async (url) => new Response(texts[url === recommendedUrl ? 0 : 1]);
    // Check only: says what differs and writes nothing.
    const checked = await bundleAdvice({ check: true, root, fetcher: serve([newer, JSON.stringify(bundledImages) + '\n']) });
    assert.deepEqual(checked.map((r) => r.same), [false, true]);
    assert.equal(await read(join(base, 'packages/models/recommended.json'), 'utf8'), bundledText);
    // Invalid or not newer: an error, nothing written.
    for (const text of ['{"version":1}', JSON.stringify({ ...bundled, roles: { ...bundled.roles, primary: [] } }), JSON.stringify(bundled)])
      await assert.rejects(bundleAdvice({ root, fetcher: serve([text, JSON.stringify(bundledImages) + '\n']) }));
    assert.equal(await read(join(base, 'packages/models/recommended.json'), 'utf8'), bundledText);
    // A newer valid file is copied byte for byte.
    await bundleAdvice({ root, fetcher: serve([newer, JSON.stringify(bundledImages) + '\n']) });
    assert.equal(await read(join(base, 'packages/models/recommended.json'), 'utf8'), newer);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
