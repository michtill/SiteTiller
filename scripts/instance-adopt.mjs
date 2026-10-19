// Takes over a copied instance (for example the Playground) on a server: the server's addresses, and the server's
// own publication history instead of the copied one. Run once, before the first start, inside the image:
//   node scripts/instance-adopt.mjs <deployment.json>
// deployment.json: { sourceRoot, editOrigin, siteUrl, productionGit, previewOrigin?, publicPreviewPort?, browser?, listen?,
//   retryDeployHook?, productionGitKey?, productionGitKnownHosts?, createVersion0FromDraft? }
// productionGit is a local path or an SSH address (ssh://user@host/path.git); an SSH address needs the private key
// and the server's known_hosts line(s) as files, which are copied to the instance's settings/.
// A production Git without any SiteTiller version (a website deployed by other means) gets Version 0 only with
// createVersion0FromDraft: the copied draft is published on top of its main, which changes the live website.
// The copied draft (steps, saved drafts, content, settings, keys) stays; none of its steps counts as published,
// because the server's history does not contain them. The copy's own publication records are archived, not deleted.
import { readFile, rename, mkdir, rm, access, copyFile, chmod, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, readJson } from '../packages/settings/index.mjs';
import { remoteGit, instanceEnvironment } from './instance-env.mjs';
import { prepareInstanceUser } from './instance-user.mjs';
const root = resolve(process.env.SITETILLER_INSTANCE || '/instance'),
  deployment = JSON.parse(await readFile(process.argv[2], 'utf8'));
// Like the services: as the owner of the instance, with a passwd entry for Git over SSH.
await prepareInstanceUser(root);
for (const key of ['sourceRoot', 'editOrigin', 'siteUrl', 'productionGit'])
  if (typeof deployment[key] !== 'string' || !deployment[key]) throw Error('deployment.json: missing ' + key);
const data = join(root, '.sitetiller'),
  exists = (path) =>
    access(path).then(
      () => true,
      () => false,
    );
const config = await readJson(join(data, 'config.json'));
if (config.pendingRelease) throw Error('The copied instance has an unfinished publication; finish it first.');
if (await exists(join(root, '.production')))
  throw Error('.production exists; the copy must not bring its own published website.');
const remote = remoteGit(deployment.productionGit);
if (remote)
  for (const [key, name] of [
    ['productionGitKey', 'production-git.key'],
    ['productionGitKnownHosts', 'production-git.known_hosts'],
  ]) {
    if (typeof deployment[key] !== 'string' || !deployment[key]) throw Error('deployment.json: missing ' + key);
    await copyFile(deployment[key], join(root, 'settings', name));
    await chmod(join(root, 'settings', name), 0o600);
  }
// 1. The instance and its addresses.
await atomicJson(join(root, 'instance.json'), {
  ...(await readJson(join(root, 'instance.json'))),
  kind: 'sitetiller-next-instance',
  root,
  public: {
    editOrigin: deployment.editOrigin,
    siteUrl: deployment.siteUrl,
    productionGit: deployment.productionGit,
    ...(deployment.previewOrigin ? { previewOrigin: deployment.previewOrigin } : {}),
    ...(deployment.browser ? { browser: deployment.browser } : {}),
    ...(deployment.listen ? { listen: deployment.listen } : {}),
    ...(deployment.retryDeployHook ? { retryDeployHook: true } : {}),
  },
  ...(deployment.publicPreviewPort
    ? { ports: { ...(await readJson(join(root, 'instance.json'))).ports, publicPreview: deployment.publicPreviewPort } }
    : {}),
});
const shared = await readJson(join(root, 'settings/shared.json'));
await atomicJson(join(root, 'settings/shared.json'), { ...shared, siteUrl: deployment.siteUrl });
// 2. Paths recorded by the copy's Content editor.
{
  const path = join(root, '.cms-publication/current.json');
  if (await exists(path)) {
    const current = await readJson(path),
      prefix = deployment.sourceRoot.replace(/[\\/]+$/, '');
    if (typeof current.directory === 'string' && current.directory.startsWith(prefix))
      current.directory = join(root, current.directory.slice(prefix.length).replace(/\\/g, '/'));
    await atomicJson(path, current);
  }
}
// 3. The copy's publication records belong to its own history.
const archive = join(data, 'archived-source-publications');
await mkdir(archive, { recursive: true });
for (const name of ['publication-recovery', 'publisher-transactions', 'workspace-history', 'publish-approval.json'])
  if (await exists(join(data, name))) await rename(join(data, name), join(archive, name));
// 4. The server's history: its releases are the published ones; every copied step is unpublished work.
// The same production variables as the running services (a remote Git is read through the instance's mirror).
{
  const env = await instanceEnvironment(resolve('.'), root, await readJson(join(root, 'instance.json')));
  for (const key of ['SITETILLER_PRODUCTION_GIT', 'SITETILLER_PRODUCTION_HISTORY_DIR', 'SITETILLER_PRODUCTION_REMOTE', 'GIT_SSH_COMMAND'])
    if (env[key]) process.env[key] = env[key];
}
const { syncProduction, productionProject, storeProductionRelease } = await import(
    '../apps/aistudio/src/production-history.ts'
  ),
  { syncProductionMirror, pushProductionRefs } = await import('../apps/aistudio/src/production-remote.ts'),
  { Project } = await import('../apps/aistudio/src/project.ts'),
  { productionSnapshot } = await import('../apps/aistudio/src/production-snapshot.ts'),
  { deploySite } = await import('../apps/aistudio/deploy/site-release.mjs');
await syncProductionMirror();
await syncProduction(config);
if (!config.publishedCommit) {
  if (deployment.createVersion0FromDraft !== true)
    throw Error('The production history has no published version (createVersion0FromDraft publishes the draft as Version 0).');
  const production = new Project(process.env.SITETILLER_PRODUCTION_HISTORY_DIR),
    main = await production.head().catch(() => null),
    draft = new Project(join(data, 'project')),
    source = await draft.head(),
    temp = await mkdtemp(join(tmpdir(), 'sitetiller-adopt-v0-'));
  try {
    const stage = new Project(temp);
    await stage.git(['init', '-b', 'main']);
    if (main) await stage.git(['fetch', production.root, 'main']);
    const commit = await productionSnapshot(stage, source, main, draft);
    // A push (not a ref update), so a local production Git runs its deploy hooks; a remote one runs them on push.
    await stage.git(['push', production.root, commit + ':refs/heads/main']);
    await pushProductionRefs([commit + ':refs/heads/main']);
    const release = await storeProductionRelease(
      production,
      { number: 0, description: 'Výchozí verze převzaté instance', previousCommit: main },
      commit,
      source,
    );
    await pushProductionRefs(['refs/tags/' + release.tag]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await syncProduction(config);
}
Object.assign(config, {
  publishedThrough: 0,
  approvedCommit: null,
  technicalApproval: null,
  reviewedCommits: [],
  siteUrl: deployment.siteUrl,
});
await atomicJson(join(data, 'config.json'), config, { mode: 0o640 });
const events = await readJson(join(data, 'events.json')).catch(() => []);
await atomicJson(
  join(data, 'events.json'),
  events.filter((e) => e.stage !== 'published' && e.kind !== 'publish'),
);
const job = await readJson(join(data, 'last-job.json')).catch(() => null);
if (job?.kind === 'publish') await atomicJson(join(data, 'last-job.json'), null);
await rm(join(data, 'publish-approval.json'), { force: true });
// 5. The published website served by the Website service = the latest version of the server's history.
await deploySite(productionProject(), config.publishedCommit, join(root, '.production'));
console.log(
  'Adopted ' +
    root +
    ': ' +
    config.releases.length +
    ' published version(s) from ' +
    deployment.productionGit +
    '; ' +
    config.requests.length +
    ' draft step(s) kept as unpublished work.',
);
