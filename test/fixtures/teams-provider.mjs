import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal } from '../../apps/aistudio/src/core.ts';
import { initialTeam, initialImages } from '../../apps/aistudio/src/team.ts';
// Two invented custom teams (documentation 2.4, 4.2): the default one with gpt-6.1-sol as the Web Lead, and "Druhý tým"
// with gpt-6-luna. The provider answers every request at once and notes which model it was asked.
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
const roles = (model) => {
  const team = initialTeam();
  for (const role of Object.keys(team)) team[role] = { provider: 'openai', model, reasoningEffort: 'auto' };
  return team;
};
config.providers = { openai: { key: seal('fake-not-real-provider-key', key) }, anthropic: { key: '' } };
config.teams = [
  { id: 'custom-1', name: 'Vlastní tým', roles: roles('gpt-6.1-sol'), imageModels: initialImages() },
  { id: 'custom-2', name: 'Druhý tým', roles: roles('gpt-6-luna'), imageModels: initialImages() },
];
config.defaultTeam = 'custom-1';
config.roles = roles('gpt-6.1-sol');
await writeFile(join(data, 'config.json'), JSON.stringify(config));
const realFetch = globalThis.fetch,
  asked = [];
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/models')
    return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'].map((id) => ({ id })) });
  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses') {
    asked.push(JSON.parse(options.body).model);
    await writeFile(join(root, 'fixture-models-asked.json'), JSON.stringify(asked));
    return Response.json({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ action: 'answer', summary: 'note', finalAnswer: 'Toto je váš web.' }),
            },
          ],
        },
      ],
      usage: {},
    });
  }
  if (url.hostname === 'raw.githubusercontent.com') return new Response('Not Found', { status: 404 });
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Fixture denies actual provider/network calls');
  return realFetch(input, options);
};
