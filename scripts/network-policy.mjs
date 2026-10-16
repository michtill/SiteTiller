export const networkModes = ['offline', 'providers'];
export function normalizeNetworkMode(value) {
  const mode = value ?? 'offline';
  if (!networkModes.includes(mode)) throw Error('Invalid instance network mode');
  return mode;
}
export function allowedNetworkURL(mode, input) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol))
    return true;
  return (
    mode === 'providers' &&
    url.protocol === 'https:' &&
    (!url.port || url.port === '443') &&
    !url.username &&
    !url.password &&
    ['api.openai.com', 'api.anthropic.com'].includes(url.hostname) &&
    url.pathname.startsWith('/v1/')
  );
}
export function installNetworkPolicy(mode) {
  normalizeNetworkMode(mode);
  const original = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    if (!allowedNetworkURL(mode, input))
      throw Object.assign(
        Error(
          mode === 'offline'
            ? 'Připojení poskytovatelů je v této instanci vypnuté (offline).'
            : 'Tato instance dovoluje jen místní služby a API OpenAI/Anthropic.',
        ),
        { code: 'ERR_SITETILLER_NETWORK_BLOCKED', networkMode: mode },
      );
    return original(input, options);
  };
  return () => {
    globalThis.fetch = original;
  };
}
const mode =
  process.env.SITETILLER_OFFLINE === '1' ? 'offline' : normalizeNetworkMode(process.env.SITETILLER_NETWORK_MODE);
installNetworkPolicy(mode);
// Credentials come only from this instance's encrypted config or explicit Studio input.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
