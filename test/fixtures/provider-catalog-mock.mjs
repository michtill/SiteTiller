import { initialTeam, initialImages } from '../../apps/aistudio/src/team.ts';
import { allowedNetworkURL } from '../../scripts/network-policy.mjs';
import { recommendedSetsUrl } from '../../packages/models/index.mjs';
// Invented provider keys in the real shapes (documentation 2.4: the provider is told by the shape).
export const fixtureKeys = {
  openai: 'sk-proj-fixtureOpenaiKey0000000000',
  anthropic: 'sk-ant-fixtureAnthropicKey000000000',
  gemini: 'AIzaFixtureGeminiKey0000000000000000000',
  geminiAuth: 'AQ.AbFixtureGeminiAuthKey0000000000000000000',
};
const original = globalThis.fetch;
const models = [
  ...new Set([...Object.values(initialTeam()).map((role) => role.model), ...Object.values(initialImages())]),
];
// Gemini's list: two text models (one preview) and one embedding model that is not offered.
const geminiModels = [
  { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
  {
    name: 'models/gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro',
    supportedGenerationMethods: ['generateContent'],
  },
  { name: 'models/text-embedding-004', displayName: 'Text Embedding', supportedGenerationMethods: ['embedContent'] },
];
// A newer recommendation sets file on GitHub (documentation 4.6): Gemini first for the Web Lead of the performance
// set, and an economy set the shipped file does not have.
const images = {
  precise: [{ provider: 'openai', model: 'gpt-image-2.5-sunburst' }],
  fast: [{ provider: 'openai', model: 'gpt-image-2.5-flare' }],
};
export const onlineRecommendation = {
  version: 2,
  revision: 99,
  date: '2026-10-22',
  default: 'performance',
  sets: {
    performance: {
      name: { cs: 'Výkonný tým', en: 'Performance team' },
      description: { cs: 'Nejsilnější modely.', en: 'The strongest models.' },
      roles: {
        primary: [
          { provider: 'gemini', model: 'gemini-2.5-pro' },
          { provider: 'openai', model: 'gpt-6-sol' },
        ],
        ui: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
        verify: [{ provider: 'openai', model: 'gpt-6-luna' }],
        escalation: [{ provider: 'openai', model: 'gpt-6-astra', effort: 'high' }],
      },
      images,
    },
    economy: {
      name: { cs: 'Ekonomický tým', en: 'Economy team' },
      description: { cs: 'Levnější modely na běžné úpravy.', en: 'Cheaper models for everyday edits.' },
      roles: {
        primary: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
        ui: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
        verify: [{ provider: 'openai', model: 'gpt-6-luna' }],
        escalation: [{ provider: 'openai', model: 'gpt-6-astra', effort: 'high' }],
      },
      images: { precise: images.fast, fast: images.fast },
    },
  },
};
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // Tests never reach the real GitHub.
  if (url.href === recommendedSetsUrl) {
    if (!allowedNetworkURL(process.env.SITETILLER_NETWORK_MODE, url)) return original(input, options);
    return Promise.resolve(new Response(JSON.stringify(onlineRecommendation)));
  }
  if (['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'].includes(url.hostname)) {
    if (!allowedNetworkURL(process.env.SITETILLER_NETWORK_MODE, url)) return original(input, options);
    const headers = new Headers(options?.headers);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      if (url.pathname !== '/v1beta/models' || (options?.method || 'GET') !== 'GET')
        throw Error('Fixture forbids paid/provider generation calls');
      if (url.searchParams.has('key')) throw Error('The Gemini key must not be in the address');
      if (![fixtureKeys.gemini, fixtureKeys.geminiAuth].includes(headers.get('x-goog-api-key')))
        return Promise.resolve(Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }));
      return Promise.resolve(Response.json({ models: geminiModels }));
    }
    if (url.pathname !== '/v1/models' || (options?.method || 'GET') !== 'GET')
      throw Error('Fixture forbids paid/provider generation calls');
    if (url.hostname === 'api.openai.com' && headers.get('authorization') !== 'Bearer ' + fixtureKeys.openai)
      return Promise.resolve(Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 }));
    if (url.hostname === 'api.anthropic.com' && headers.get('x-api-key') !== fixtureKeys.anthropic)
      return Promise.resolve(Response.json({ error: { type: 'authentication_error' } }, { status: 401 }));
    return Promise.resolve(Response.json({ data: models.map((id) => ({ id })), has_more: false }));
  }
  return original(input, options);
};
