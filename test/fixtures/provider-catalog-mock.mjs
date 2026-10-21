import { initialTeam, initialImages } from '../../apps/aistudio/src/team.ts';
import { allowedNetworkURL } from '../../scripts/network-policy.mjs';
import { recommendedUrl } from '../../packages/models/index.mjs';
// Invented provider keys in the real shapes (documentation 2.4: the provider is told by the shape).
export const fixtureKeys = {
  openai: 'sk-proj-fixtureOpenaiKey0000000000',
  anthropic: 'sk-ant-fixtureAnthropicKey000000000',
  gemini: 'AIzaFixtureGeminiKey0000000000000000000',
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
// A newer recommended models file on GitHub (documentation 4.6): Gemini first for the Web Lead.
export const onlineRecommendation = {
  version: 1,
  date: '2099-01-01',
  roles: {
    primary: [
      { provider: 'gemini', model: 'gemini-2.5-pro' },
      { provider: 'openai', model: 'gpt-6-sol' },
    ],
    ui: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    verify: [{ provider: 'openai', model: 'gpt-6-luna' }],
    escalation: [{ provider: 'openai', model: 'gpt-6-astra', effort: 'high' }],
  },
};
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === recommendedUrl) {
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
      if (headers.get('x-goog-api-key') !== fixtureKeys.gemini)
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
