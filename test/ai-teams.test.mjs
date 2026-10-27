import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  migrateTeams,
  teamOf,
  teamList,
  applyRecommended,
  createTeam,
  validTeamName,
} from '../apps/aistudio/src/teams.ts';
import { fixtureKeys, onlineRecommendation } from './fixtures/provider-catalog-mock.mjs';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser, studioFrame } from './support/browser.mjs';
// AI teams (documentation 2.4, 4.2, 4.6). Invented models and teams.
const roles = (model, provider = 'openai') => ({
  primary: { provider, model, reasoningEffort: 'auto' },
  ui: { provider, model, reasoningEffort: 'auto' },
  verify: { provider, model, reasoningEffort: 'auto' },
  escalation: { provider, model, reasoningEffort: 'high' },
});
const images = { precise: 'none', fast: 'none' };
test('AI-37: an older team becomes the custom team "Vlastní tým"; the recommended team keeps the default set', () => {
  const own = { roles: roles('own-model'), imageModels: images };
  const custom = { roles: roles('custom-model'), imageModels: images, autoTeam: false };
  assert.equal(migrateTeams(custom, onlineRecommendation), true);
  assert.equal(custom.defaultTeam, 'custom-1');
  assert.deepEqual(custom.teams, [
    { id: 'custom-1', name: 'Vlastní tým', ...{ roles: roles('custom-model'), imageModels: images } },
  ]);
  // Who used the recommended team keeps it, and the custom team they had saved aside is not lost.
  const auto = { roles: roles('recommended-model'), imageModels: images, autoTeam: true, customTeam: own };
  migrateTeams(auto, onlineRecommendation);
  assert.equal(auto.defaultTeam, 'performance');
  assert.equal(auto.teams[0].roles.primary.model, 'own-model');
  // Only once.
  assert.equal(migrateTeams(auto, onlineRecommendation), false);
});
test('AI-37: recommended and custom teams are all valid; a vanished default set gives way to the default set with a notice', () => {
  const config = { roles: roles('old'), imageModels: images, teams: [], defaultTeam: 'economy' };
  const models = [
    { provider: 'gemini', id: 'gemini-2.5-pro', usable: true },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', usable: true },
    { provider: 'openai', id: 'gpt-6-luna', usable: true },
    { provider: 'openai', id: 'gpt-image-2.5-flare' },
  ];
  const keys = { openai: 'k', anthropic: 'k', gemini: 'k' };
  applyRecommended(config, onlineRecommendation, models, keys);
  assert.deepEqual(
    teamList(config, onlineRecommendation).map((t) => [t.id, t.kind]),
    [
      ['performance', 'recommended'],
      ['economy', 'recommended'],
    ],
  );
  // The default team is mirrored in the roles the AI Studio uses.
  assert.equal(config.roles.primary.model, 'claude-sonnet-5-5');
  assert.equal(teamOf(config, onlineRecommendation, 'performance').roles.primary.model, 'gemini-2.5-pro');
  // A copy of the shown team, named with the first free number.
  const copy = createTeam(config, teamOf(config, onlineRecommendation, 'economy'));
  assert.deepEqual([copy.id, copy.name], ['custom-1', 'Vlastní tým 1']);
  assert.equal(teamOf(config, onlineRecommendation, copy.id).kind, 'custom');
  assert.equal(validTeamName('Levný'), true);
  assert.equal(validTeamName(''), false);
  assert.equal(validTeamName('x'.repeat(41)), false);
  // The economy set disappears from the recommendation: the default set becomes the default team, and it is said.
  const shrunk = { ...onlineRecommendation, sets: { performance: onlineRecommendation.sets.performance } };
  applyRecommended(config, shrunk, models, keys);
  assert.equal(config.defaultTeam, 'performance');
  assert.deepEqual(config.teamNotice, { missing: { cs: 'Ekonomický tým', en: 'Economy team' } });
  assert.equal(config.roles.primary.model, 'gemini-2.5-pro');
});
test(
  'AI-37: a request runs with the chosen team, which is frozen for it and carried by the step',
  { timeout: 120000 },
  async () => {
    const stack = await isolatedStack({ controllerImports: ['test/fixtures/teams-provider.mjs'] });
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
      const state = async () => await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      const run = (body) =>
        fetch(stack.origin + '/site/api/run', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            prompt: 'What is this website?',
            checks: { technical: false, verification: false },
            ...body,
          }),
        });
      const unknown = await run({ team: 'no-such-team' });
      assert.equal(unknown.status, 422);
      assert.match((await unknown.json()).error, /Tým neexistuje/);
      assert.equal((await run({ team: 'custom-2' })).status, 202);
      let after;
      for (let i = 0; i < 200; i++) {
        after = await state();
        if (!after.busy) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const request = after.requests.at(-1);
      assert.deepEqual(request.team, { id: 'custom-2', kind: 'custom', name: 'Druhý tým' });
      assert.equal(request.models.primary.model, 'gpt-6-luna');
      assert.deepEqual(
        [...new Set(JSON.parse(await readFile(join(stack.root, 'fixture-models-asked.json'), 'utf8')))],
        ['gpt-6-luna'],
      );
      // The default team did not change.
      assert.equal(after.defaultTeam, 'custom-1');
    } finally {
      await stack.close();
    }
  },
);
test(
  'AI-37: Settings shows every team as a tab in place, makes one the default, creates, renames and deletes a custom team',
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
      await page.waitForURL((url) => url.pathname === '/');
      await page.goto(stack.origin + '/settings/aiapi');
      const settings = await studioFrame(page, 'settings');
      for (const [key, name] of [
        [fixtureKeys.openai, 'OpenAI'],
        [fixtureKeys.anthropic, 'Anthropic'],
      ]) {
        await settings.locator('input[name=key]').fill(key);
        await settings.getByRole('button', { name: 'Přidat klíč', exact: true }).click();
        await settings.getByText('Klíč ' + name + ' je uložený.', { exact: true }).waitFor();
      }
      const tab = (name) => settings.locator('.team-tabs a', { hasText: name });
      const api = async () => await (await page.request.get(stack.origin + '/site/api/state')).json();
      // The sets of the newer GitHub file and the migrated custom team; the custom team is the default one.
      assert.deepEqual(await settings.locator('.team-tabs a').allTextContents(), [
        'Výkonný tým',
        'Ekonomický tým',
        'Vlastní tým',
      ]);
      assert.equal(await tab('Vlastní tým').getAttribute('aria-current'), 'page');
      assert.notEqual(await tab('Vlastní tým').getAttribute('data-default'), null);
      await settings.getByText('Seznam modelů je načtený.', { exact: true }).waitFor();
      // A tab only shows its team, in place.
      await settings.evaluate(() => {
        window.samePage = true;
      });
      await tab('Ekonomický tým').click();
      await settings.getByText('Levnější modely na běžné úpravy.', { exact: true }).waitFor();
      assert.equal(await tab('Ekonomický tým').getAttribute('aria-current'), 'page');
      assert.equal(await settings.locator('select[name=role_primary]').isDisabled(), true);
      assert.equal(await settings.locator('select[name=role_primary]').inputValue(), 'anthropic|claude-sonnet-5-5');
      assert.equal((await api()).defaultTeam, 'custom-1');
      // Make default saves in place.
      await settings.getByRole('button', { name: 'Nastavit jako výchozí', exact: true }).click();
      await settings.locator('.team-status:not([data-busy])').getByText('Výchozí tým', { exact: true }).waitFor();
      assert.equal(await settings.evaluate(() => window.samePage), true);
      assert.notEqual(await tab('Ekonomický tým').getAttribute('data-default'), null);
      let state = await api();
      assert.equal(state.defaultTeam, 'economy');
      assert.equal(state.roles.primary.model, 'claude-sonnet-5-5');
      // Update checks GitHub at once.
      await settings.getByRole('button', { name: 'Aktualizovat', exact: true }).click();
      await settings.locator('.team-status:not([data-busy])').waitFor();
      await settings.getByText('Doporučení GitHub 2026-10-22', { exact: true }).waitFor();
      // A new custom team is a copy of the shown one; it is renamed and saved.
      await settings.getByRole('button', { name: '+ Nový tým', exact: true }).click();
      await settings.waitForURL(/team=custom-2/);
      assert.equal(await tab('Vlastní tým 2').getAttribute('aria-current'), 'page');
      assert.equal(await settings.locator('select[name=role_primary]').inputValue(), 'anthropic|claude-sonnet-5-5');
      await settings.locator('input[name=teamName]').fill('Levný');
      await settings.getByRole('button', { name: 'Uložit', exact: true }).click();
      await settings.getByText('Uloženo', { exact: true }).waitFor();
      assert.equal(await tab('Levný').getAttribute('aria-current'), 'page');
      // The default team cannot be deleted; another custom team can, after the dialog.
      await tab('Vlastní tým').click();
      await settings.waitForFunction(
        (name) => document.querySelector('input[name=teamName]').value === name,
        'Vlastní tým',
      );
      assert.equal(await settings.locator('#team-delete').isVisible(), true);
      await tab('Levný').click();
      await settings.waitForFunction((name) => document.querySelector('input[name=teamName]').value === name, 'Levný');
      await settings.locator('#team-delete').click();
      await settings.locator('dialog').getByRole('button', { name: 'Smazat tým', exact: true }).click();
      await settings.waitForURL(/team=economy/);
      assert.deepEqual(await settings.locator('.team-tabs a').allTextContents(), [
        'Výkonný tým',
        'Ekonomický tým',
        'Vlastní tým',
      ]);
      state = await api();
      assert.deepEqual(
        state.teams.map((t) => t.id),
        ['performance', 'economy', 'custom-1'],
      );
      // The default team has no Delete.
      await settings.getByRole('button', { name: 'Nastavit jako výchozí', exact: true }).waitFor({ state: 'hidden' });
      await tab('Vlastní tým').click();
      await settings.getByRole('button', { name: 'Nastavit jako výchozí', exact: true }).click();
      await settings.locator('.team-status:not([data-busy])').getByText('Výchozí tým', { exact: true }).waitFor();
      assert.equal(await settings.locator('#team-delete').isVisible(), false);
      // The AI Studio offers every team for the next request, the default one chosen; the choice closes when the
      // user clicks elsewhere.
      state = await api();
      assert.equal(state.defaultTeam, 'custom-1');
      await page.goto(stack.origin + '/site/');
      const studio = await studioFrame(page, 'site');
      const choice = studio.locator('#team-choice');
      await choice.locator('summary').waitFor();
      assert.equal(await studio.locator('#team-choice-label').textContent(), 'Vlastní tým');
      await choice.locator('summary').click();
      assert.deepEqual(await choice.locator('button strong').allTextContents(), [
        'Výkonný tým',
        'Ekonomický tým',
        'Vlastní tým',
      ]);
      await studio.locator('body').click({ position: { x: 5, y: 5 } });
      assert.equal(await choice.evaluate((d) => d.open), false);
      await choice.locator('summary').click();
      await choice.getByRole('button', { name: /Ekonomický tým/ }).click();
      assert.equal(await studio.locator('#team-choice-label').textContent(), 'Ekonomický tým');
      assert.equal(await choice.evaluate((d) => d.open), false);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
