import { initialTeam, initialImages } from '../../apps/aistudio/src/team.ts';
import { allowedNetworkURL } from '../../scripts/network-policy.mjs';
const original = globalThis.fetch;
const models = [
  ...new Set([...Object.values(initialTeam()).map((role) => role.model), ...Object.values(initialImages())]),
];
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['api.openai.com', 'api.anthropic.com'].includes(url.hostname)) {
    if (!allowedNetworkURL(process.env.SITETILLER_NETWORK_MODE, url)) return original(input, options);
    if (url.pathname !== '/v1/models' || (options?.method || 'GET') !== 'GET')
      throw Error('Fixture forbids paid/provider generation calls');
    const headers = new Headers(options?.headers);
    if (url.hostname === 'api.openai.com' && headers.get('authorization') !== 'Bearer fixture-openai-key')
      return Promise.resolve(Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 }));
    if (url.hostname === 'api.anthropic.com' && headers.get('x-api-key') !== 'fixture-anthropic-key')
      return Promise.resolve(Response.json({ error: { type: 'authentication_error' } }, { status: 401 }));
    return Promise.resolve(Response.json({ data: models.map((id) => ({ id })), has_more: false }));
  }
  return original(input, options);
};
