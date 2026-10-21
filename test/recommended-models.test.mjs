import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recommendedUrl,
  validRecommendation,
  parseRecommendation,
  recommendedTeam,
} from '../packages/models/index.mjs';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { fixtureKeys } from './fixtures/provider-catalog-mock.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser } from './support/browser.mjs';
// Recommended models (documentation 4.6).
const bundled = JSON.parse(await readFile(new URL('../packages/models/recommended.json', import.meta.url), 'utf8'));
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
test('AI-35: only the one GitHub address of the file, and only in the providers mode', () => {
  assert.equal(allowedNetworkURL('providers', recommendedUrl), true);
  assert.equal(allowedNetworkURL('offline', recommendedUrl), false);
  for (const url of [
    recommendedUrl.replace('/main/', '/other/'),
    recommendedUrl + '?x=1',
    'https://raw.githubusercontent.com/michtill/SiteTiller/main/package.json',
  ])
    assert.equal(allowedNetworkURL('providers', url), false, url);
});
test(
  'AI-35: Team automatically by the recommendation follows the newer GitHub file and the keys; the choices are read only with the date and source',
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
      // Off by default.
      const auto = page.locator('input[name=autoTeam]');
      assert.equal(await auto.isChecked(), false);
      assert.equal(await page.locator('select[name=role_primary]').isDisabled(), false);
      await auto.check();
      assert.equal(await page.locator('select[name=role_primary]').isDisabled(), true);
      await page.getByRole('button', { name: 'Uložit', exact: true }).click();
      await page.getByText('Uloženo', { exact: true }).waitFor();
      let state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.equal(state.autoTeam, true);
      // The GitHub file is newer than the shipped one, so it wins; Gemini has no key and gpt-6-sol is not in the
      // catalog, so the Web Lead stays; the others follow the file.
      assert.deepEqual(state.recommendation, { date: '2099-01-01', source: 'online' });
      assert.deepEqual(state.roles.primary, { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'auto' });
      assert.deepEqual(state.roles.ui, { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'auto' });
      await page.getByText('Podle doporučení z 2099-01-01 (staženo z GitHubu).', { exact: true }).waitFor();
      // A Gemini key: the Web Lead becomes Gemini at the next catalog load.
      await page.locator('input[name=key]').fill(fixtureKeys.gemini);
      await page.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
      await page.getByText('Klíč Google Gemini je uložený.', { exact: true }).waitFor();
      await page.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.deepEqual(state.roles.primary, { provider: 'gemini', model: 'gemini-2.5-pro', reasoningEffort: 'auto' });
      assert.equal(await page.locator('select[name=role_primary]').inputValue(), 'gemini|gemini-2.5-pro');
      // Off again: the team stays as it is and is editable.
      await auto.uncheck();
      await page.getByRole('button', { name: 'Uložit', exact: true }).click();
      await page.getByText('Uloženo', { exact: true }).waitFor();
      state = await (await page.request.get(stack.origin + '/site/api/state')).json();
      assert.equal(state.autoTeam, false);
      assert.equal(state.roles.primary.provider, 'gemini');
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
