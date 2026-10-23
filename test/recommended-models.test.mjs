import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recommendedSetsUrl,
  validRecommendationSets,
  parseRecommendationSets,
  recommendedTeam,
  recommendedImageTools,
} from '../packages/models/index.mjs';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
import { isolatedStack } from './support/stack.mjs';
// Recommendation sets (documentation 4.6).
const bundled = JSON.parse(await readFile(new URL('../packages/models/recommended-sets.json', import.meta.url), 'utf8'));
const set = bundled.sets[bundled.default];
const withSet = (changes) => ({ ...bundled, sets: { ...bundled.sets, [bundled.default]: { ...set, ...changes } } });
test('AI-35: the recommendation sets file is data only; anything outside its shape refuses the whole file', () => {
  assert.equal(validRecommendationSets(bundled), true);
  const broken = [
    { ...bundled, extra: 1 },
    { ...bundled, version: 1 },
    { ...bundled, date: 'tomorrow' },
    { ...bundled, revision: 0 },
    { ...bundled, revision: 1.5 },
    { ...bundled, revision: '2' },
    (({ revision, ...rest }) => rest)(bundled),
    { ...bundled, default: 'missing' },
    { ...bundled, sets: {} },
    { ...bundled, sets: { 'Bad Id': set } },
    withSet({ name: { cs: 'Jen česky' } }),
    withSet({ name: { cs: 'x'.repeat(41), en: 'x' } }),
    withSet({ description: { cs: '', en: 'x' } }),
    withSet({ roles: { ...set.roles, images: [] } }),
    withSet({ roles: { ...set.roles, ui: [] } }),
    withSet({ roles: { ...set.roles, ui: [{ provider: 'xai', model: 'grok' }] } }),
    withSet({ roles: { ...set.roles, ui: [{ provider: 'openai', model: 'gpt-6 && rm -rf /' }] } }),
    withSet({ roles: { ...set.roles, ui: [{ provider: 'openai', model: 'gpt-6', run: 'code' }] } }),
    withSet({ roles: { ...set.roles, ui: [{ provider: 'openai', model: 'gpt-6', effort: 'max' }] } }),
    withSet({ images: { ...set.images, other: [] } }),
    withSet({ images: { ...set.images, fast: [{ provider: 'gemini', model: 'gemini-3.8-flash' }] } }),
    withSet({ images: { ...set.images, fast: [{ provider: 'openai', model: 'gemini-3-pro-image' }] } }),
  ];
  for (const value of broken) assert.equal(validRecommendationSets(value), false, JSON.stringify(value).slice(0, 160));
  assert.equal(parseRecommendationSets('{not json'), null);
  assert.equal(parseRecommendationSets(JSON.stringify(bundled) + ' '.repeat(70000)), null);
  // A recommendation is only a proposal: a Verifier from the Web Lead's provider is allowed.
  assert.equal(
    validRecommendationSets(
      withSet({ roles: { ...set.roles, verify: [{ provider: set.roles.primary[0].provider, model: 'same-provider' }] } }),
    ),
    true,
  );
  // Google's Nano Banana models have no "image" in their id and are image models too.
  assert.equal(
    validRecommendationSets(withSet({ images: { ...set.images, fast: [{ provider: 'gemini', model: 'gemini-nano-banana-2.1' }] } })),
    true,
  );
});
test('AI-35: each role and image tool gets the first recommended model with a key and in the catalog; otherwise it stays', () => {
  const current = {
    primary: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    ui: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    verify: { provider: 'openai', model: 'old', reasoningEffort: 'auto' },
    escalation: { provider: 'openai', model: 'old', reasoningEffort: 'high' },
  };
  const recommendation = {
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
    images: {
      precise: [{ provider: 'gemini', model: 'gemini-3-pro-image' }],
      fast: [{ provider: 'openai', model: 'gpt-image-2.5-flare' }],
    },
  };
  const models = [
    { provider: 'openai', id: 'gpt-here', usable: true },
    { provider: 'anthropic', id: 'claude-x', usable: true },
    { provider: 'gemini', id: 'gemini-2.5-pro', usable: true },
    { provider: 'gemini', id: 'gemini-3-pro-image' },
    { provider: 'openai', id: 'gpt-image-2.5-flare' },
  ];
  const keys = { openai: 'k', anthropic: '', gemini: '' };
  const team = recommendedTeam(recommendation, models, keys, current);
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
  // No Gemini key: the precise tool stays, the fast one follows the recommendation.
  assert.deepEqual(recommendedImageTools(recommendation, models, keys, { precise: 'none', fast: 'none' }), {
    precise: 'none',
    fast: 'gpt-image-2.5-flare',
  });
});
test('AI-35: only the one GitHub address of the file, and only in the providers mode', () => {
  assert.equal(allowedNetworkURL('providers', recommendedSetsUrl), true);
  assert.equal(allowedNetworkURL('offline', recommendedSetsUrl), false);
  for (const url of [
    recommendedSetsUrl.replace('/main/', '/other/'),
    recommendedSetsUrl + '?x=1',
    recommendedSetsUrl.replace('/v2.json', '/v1.json'),
    'https://raw.githubusercontent.com/michtill/SiteTiller-advice/main/README.md',
    // The application's own repository is not read: a release would overwrite the file there.
    'https://raw.githubusercontent.com/michtill/SiteTiller/main/packages/models/recommended.json',
  ])
    assert.equal(allowedNetworkURL('providers', url), false, url);
});
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
    const refreshed = await fetch(stack.origin + '/site/api/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'refresh', teamId: bundled.default }),
    });
    assert.equal(refreshed.status, 200);
    const after = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
    assert.deepEqual(after.recommendation, { date: bundled.date, revision: bundled.revision, source: 'bundled' });
    assert.deepEqual(
      after.teams.filter((t) => t.kind === 'recommended').map((t) => t.id),
      Object.keys(bundled.sets),
    );
    await assert.rejects(access(join(stack.root, '.sitetiller/recommended-sets-online.json')));
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
    const file = join(base, 'packages/models/recommended-sets.json'),
      bundledText = JSON.stringify(bundled) + '\n';
    await write(file, bundledText);
    const root = pathToFileURL(base + '/');
    // Newer by revision; the date is the real day, the same here.
    const newer = JSON.stringify({ ...bundled, revision: bundled.revision + 1 }, null, 2) + '\n';
    const serve = (text) => async () => new Response(text);
    // Check only: says what differs and writes nothing.
    const checked = await bundleAdvice({ check: true, root, fetcher: serve(newer) });
    assert.deepEqual(checked.map((r) => r.same), [false]);
    assert.equal(await read(file, 'utf8'), bundledText);
    // Invalid or not newer: an error, nothing written.
    for (const text of ['{"version":2}', JSON.stringify({ ...bundled, sets: {} }), JSON.stringify(bundled)])
      await assert.rejects(bundleAdvice({ root, fetcher: serve(text) }));
    assert.equal(await read(file, 'utf8'), bundledText);
    // A newer valid file is copied byte for byte.
    await bundleAdvice({ root, fetcher: serve(newer) });
    assert.equal(await read(file, 'utf8'), newer);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
