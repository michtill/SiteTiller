import { providers } from '../packages/providers/index.mjs';
import { recommendedSetsUrl } from '../packages/models/index.mjs';
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
  // The Publisher verifies the hosted website at its own public address (SITETILLER_WWW_URL), nothing else.
  if (process.env.SITETILLER_WWW_URL && url.origin === new URL(process.env.SITETILLER_WWW_URL).origin) return true;
  // The recommendation sets file, read from one fixed address (documentation 4.6); nothing leaves the instance.
  if (mode === 'providers' && url.href === recommendedSetsUrl) return true;
  return (
    mode === 'providers' &&
    url.protocol === 'https:' &&
    (!url.port || url.port === '443') &&
    !url.username &&
    !url.password &&
    providers.some((p) => p.host === url.hostname && url.pathname.startsWith(p.path))
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
            : 'Tato instance dovoluje jen místní služby a API OpenAI, Anthropic a Google Gemini.',
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
