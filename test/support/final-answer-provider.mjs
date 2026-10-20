import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal } from '../../apps/aistudio/src/core.ts';
import { initialTeam } from '../../apps/aistudio/src/team.ts';
const root = resolve(process.env.SITETILLER_INSTANCE_ROOT || '');
if (!root.includes('example-real-integration-') || !root.startsWith(resolve('work') + sep))
  throw Error('Fixture refuses non-disposable instance');
const data = join(root, '.sitetiller'),
  config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
let key;
try {
  key = await readFile(join(data, 'master.key'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  key = randomBytes(32);
  await writeFile(join(data, 'master.key'), key);
}
config.providers = { openai: { key: seal('fake-not-real-provider-key', key) }, anthropic: { key: '' } };
config.roles = initialTeam();
config.roles.ui = { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
await writeFile(join(data, 'config.json'), JSON.stringify(config));
const realFetch = globalThis.fetch,
  trace = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/models')
    return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'].map((id) => ({ id })) });
  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses') {
    const envelope = JSON.parse(options.body),
      ctx = JSON.parse(envelope.input);
    trace.push({ language: ctx.finalResponseLanguage, prompt: ctx.originalRequest, tools: !!envelope.tools });
    await writeFile(join(root, 'fixture-provider-trace.json'), JSON.stringify(trace));
    if (trace.length === 1) {
      await writeFile(
        join(root, 'fixture-provider-entered.json'),
        JSON.stringify({ language: ctx.finalResponseLanguage }),
      );
      let released = false;
      for (let i = 0; i < 400; i++) {
        try {
          await readFile(join(root, 'fixture-provider-release'));
          released = true;
          break;
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!released) throw Error('Fixture release timeout');
    }
    const text = ctx.finalResponseLanguage === 'en' ? 'This is your website.' : 'Toto je váš web.';
    return Response.json({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ action: 'answer', summary: 'Internal English note', finalAnswer: text }),
            },
          ],
        },
      ],
      usage: {},
    });
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Fixture denies actual provider/network calls');
  return realFetch(input, options);
};
