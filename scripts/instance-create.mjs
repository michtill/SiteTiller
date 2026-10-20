// Creates a new, empty SiteTiller instance on a server and connects it, in one step. Run once inside the image:
//   node scripts/instance-create.mjs <deployment.json>
// deployment.json: as for instance-adopt.mjs (sourceRoot is not needed), plus adminEmail (required: password reset and
// website forms, documentation 2.4), name? and networkMode? (default providers). Without productionGit the version history is the instance's own Git, Version 0 = the new draft.
// The instance has no collections, no files and a "new website" draft; its password is printed once
// (change it in the Studio menu under Password) and stored only as a hash. An existing instance is never touched.
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicJson, passwordHash, validEmail } from '../packages/settings/index.mjs';
import { prepareInstanceUser } from './instance-user.mjs';
const exec = promisify(execFile),
  repo = resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = resolve(process.env.SITETILLER_INSTANCE || '/instance'),
  deployment = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!validEmail(deployment.adminEmail)) throw Error('deployment.adminEmail: the administrator e-mail is required');
await prepareInstanceUser(root);
const present = await readdir(root).catch(() => []);
if (present.length) throw Error('The instance directory is not empty; instance-create never overwrites: ' + root);
const ports = { shell: 4540, cmstudio: 4510, aistudio: 4520, preview: 4521, publisher: 4523, website: 4512 },
  settings = join(root, 'settings'),
  data = join(root, '.sitetiller');
for (const folder of ['schema', 'data', 'media', 'settings', '.sitetiller', 'logs'])
  await mkdir(join(root, folder), { recursive: true });
// Empty content: no collections, no folders.
await atomicJson(join(root, 'schema/structure.json'), { version: 1, lists: {}, folders: {} });
await atomicJson(join(root, 'instance.json'), {
  kind: 'sitetiller-instance',
  root,
  ports,
  networkMode: deployment.networkMode || 'providers',
});
await atomicJson(join(settings, 'shared.json'), {
  name: deployment.name || new URL(deployment.siteUrl).hostname,
  theme: 'green',
  language: 'cs',
  adminEmail: deployment.adminEmail,
});
const password = randomBytes(12).toString('base64url');
await atomicJson(join(settings, 'auth.json'), { password: passwordHash(password) });
for (const name of ['gateway.token', 'publish.token'])
  await writeFile(join(settings, name), randomBytes(32).toString('hex'), { mode: 0o600 });
// The draft: the "new website" page with the (empty) content frozen into it.
const { Project } = await import('../apps/aistudio/src/project.ts'),
  { captureCmsPublication } = await import('../apps/aistudio/src/cms-publication.ts');
const draft = new Project(join(data, 'project'));
await draft.init(null);
await captureCmsPublication(draft, root);
await atomicJson(join(data, 'config.json'), {
  slots: [],
  providers: { openai: { key: '' }, anthropic: { key: '' } },
  requests: [],
  reviewedCommits: [],
  siteUrl: deployment.siteUrl,
  historyInitialized: true,
});
// Addresses, production Git, keys and Version 0: the same step as for a copied instance.
const adopt = join(tmpdir(), 'sitetiller-create-' + randomBytes(6).toString('hex') + '.json');
try {
  await writeFile(
    adopt,
    JSON.stringify({
      ...deployment,
      sourceRoot: root,
      ...(deployment.productionGit ? {} : { createVersion0FromDraft: true }),
    }),
    { mode: 0o600 },
  );
  const { stdout } = await exec(process.execPath, [join(repo, 'scripts/instance-adopt.mjs'), adopt], {
    env: { ...process.env, SITETILLER_INSTANCE: root },
  });
  process.stdout.write(stdout);
} finally {
  await rm(adopt, { force: true });
}
console.log('Created ' + root + '. Password (shown only now): ' + password);
