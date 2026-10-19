import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { instanceEnvironment, serviceEnvironment } from '../scripts/instance-env.mjs';
const exec = promisify(execFile),
  repo = fileURLToPath(new URL('..', import.meta.url)),
  ports = { shell: 4540, cmstudio: 4510, aistudio: 4520, preview: 4521, publisher: 4523, website: 4512 };
async function settings(root) {
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(join(root, 'settings/gateway.token'), 'g'.repeat(64));
  await writeFile(join(root, 'settings/publish.token'), 'p'.repeat(64));
  await writeFile(join(root, 'settings/shared.json'), JSON.stringify({ name: 'Modrý Kocour', theme: 'green' }));
}
test('OP-02: a public instance keeps internal services on loopback and exposes only Shell and Website', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-instance-env-'));
  try {
    await settings(root);
    const local = await instanceEnvironment(repo, root, { ports, networkMode: 'providers' });
    assert.equal(local.EDIT_ORIGIN, 'http://127.0.0.1:4540');
    assert.equal(local.SITETILLER_SITE_URL, 'http://127.0.0.1:4512/');
    assert.equal(local.SITETILLER_PRODUCTION_GIT, join(root, '.production', 'repository.git'));
    const instance = {
      ports,
      networkMode: 'providers',
      public: {
        editOrigin: 'https://edit.example.cz',
        siteUrl: 'https://example.cz/',
        productionGit: '/git/site.git',
        listen: '0.0.0.0',
        browser: '/usr/bin/chromium',
        retryDeployHook: true,
      },
    };
    const env = await instanceEnvironment(repo, root, instance);
    assert.equal(env.EDIT_ORIGIN, 'https://edit.example.cz');
    assert.equal(env.SITETILLER_PREVIEW_URL, 'https://edit.example.cz/preview/');
    assert.equal(env.SITETILLER_SITE_ORIGIN, 'https://example.cz');
    assert.equal(env.SITETILLER_PRODUCTION_HISTORY_DIR, '/git/site.git');
    assert.equal(env.SITETILLER_PRODUCTION_URL, 'http://127.0.0.1:4512/');
    assert.equal(env.SITETILLER_ORIGIN, 'http://127.0.0.1:4520');
    assert.equal(env.SITETILLER_RETRY_DEPLOY_HOOK, '1');
    assert.equal(env.SITETILLER_BROWSER_EXECUTABLE, '/usr/bin/chromium');
    assert.equal(serviceEnvironment(env, instance, 'shell').EDIT_HOST, '0.0.0.0');
    assert.equal(serviceEnvironment(env, instance, 'website').HOST, '0.0.0.0');
    for (const name of ['cmstudio', 'aistudio', 'preview', 'publisher'])
      assert.equal(serviceEnvironment(env, instance, name).HOST, '127.0.0.1');
    assert.equal(serviceEnvironment(env, instance, 'publisher').SITETILLER_OFFLINE, '1');
    assert.equal(serviceEnvironment(env, instance, 'aistudio').SITETILLER_OFFLINE, '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('OP-03: adopting a copied instance keeps its draft and switches to the server publication history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sitetiller-instance-adopt-')),
    root = join(base, 'instance'),
    git = join(base, 'git', 'site.git');
  try {
    const { Project } = await import('../apps/aistudio/src/project.ts'),
      { productionSnapshot } = await import('../apps/aistudio/src/production-snapshot.ts'),
      { storeProductionRelease } = await import('../apps/aistudio/src/production-history.ts');
    // The server's history: one published version, with the hosting files beside site/.
    const server = new Project(join(base, 'server-source'));
    await server.init(null);
    await server.write({ 'site/index.html': '<!doctype html><title>Live</title><h1>Live</h1>' });
    const live = await server.commit('Live');
    const stage = new Project(join(base, 'stage'));
    await stage.init(null);
    const published = await productionSnapshot(stage, live, null, server);
    await mkdir(join(base, 'git'));
    await exec('git', ['init', '--bare', '-b', 'main', git]);
    await stage.git(['push', git, published + ':refs/heads/main']);
    await storeProductionRelease(
      new Project(git),
      { number: 0, description: 'Live', previousCommit: null },
      published,
      live,
    );
    // The copy: a draft with three steps, its own published version and publication records.
    await settings(root);
    await writeFile(
      join(root, 'instance.json'),
      JSON.stringify({ kind: 'sitetiller-next-playground', root: 'C:\\old', ports, networkMode: 'providers' }),
    );
    const draft = new Project(join(root, '.sitetiller', 'project'));
    await draft.init(null);
    await draft.write({ 'site/index.html': '<!doctype html><title>Draft</title><h1>Draft</h1>' });
    const step = await draft.commit('Draft');
    await writeFile(
      join(root, '.sitetiller/config.json'),
      JSON.stringify({
        separatedHistories: true,
        publishedCommit: 'a'.repeat(40),
        releases: [{ id: 'own', number: 3, commit: 'a'.repeat(40) }],
        publishedThrough: 34,
        closedThrough: 33,
        approvedCommit: step,
        requests: [{ id: 'one', sequence: 34, status: 'ready', commit: step, prompt: 'Krok' }],
        siteUrl: 'http://127.0.0.1:4512/',
      }),
    );
    await writeFile(
      join(root, '.sitetiller/events.json'),
      JSON.stringify([
        { jobId: 'one', stage: 'ready', commit: step },
        { jobId: 'pub', kind: 'publish', stage: 'published', commit: 'a'.repeat(40) },
      ]),
    );
    await writeFile(join(root, '.sitetiller/last-job.json'), JSON.stringify({ kind: 'publish', status: 'ready' }));
    await mkdir(join(root, '.sitetiller/publication-recovery/x'), { recursive: true });
    await mkdir(join(root, '.cms-publication/releases/r1'), { recursive: true });
    await writeFile(
      join(root, '.cms-publication/current.json'),
      JSON.stringify({ id: 'r1', directory: 'C:\\Dev\\play\\.cms-publication\\releases\\r1' }),
    );
    const deployment = join(base, 'deployment.json');
    await writeFile(
      deployment,
      JSON.stringify({
        sourceRoot: 'C:\\Dev\\play',
        editOrigin: 'https://edit.example.cz',
        siteUrl: 'https://example.cz/',
        productionGit: git,
        listen: '0.0.0.0',
      }),
    );
    await exec(process.execPath, [join(repo, 'scripts/instance-adopt.mjs'), deployment], {
      env: { ...process.env, SITETILLER_INSTANCE: root },
    });
    const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8')),
      config = JSON.parse(await readFile(join(root, '.sitetiller/config.json'), 'utf8')),
      events = JSON.parse(await readFile(join(root, '.sitetiller/events.json'), 'utf8')),
      cms = JSON.parse(await readFile(join(root, '.cms-publication/current.json'), 'utf8')),
      current = JSON.parse(await readFile(join(root, '.production/current.json'), 'utf8'));
    assert.equal(instance.kind, 'sitetiller-next-instance');
    assert.equal(instance.root, root);
    assert.equal(instance.public.editOrigin, 'https://edit.example.cz');
    assert.equal(JSON.parse(await readFile(join(root, 'settings/shared.json'), 'utf8')).siteUrl, 'https://example.cz/');
    // The server's version is the published one; the copied step stays, as unpublished work.
    assert.deepEqual(
      config.releases.map((r) => r.number),
      [0],
    );
    assert.equal(config.publishedCommit, published);
    assert.equal(config.publishedThrough, 0);
    assert.equal(config.approvedCommit, null);
    assert.deepEqual(
      config.requests.map((r) => r.id),
      ['one'],
    );
    assert.deepEqual(
      events.map((e) => e.jobId),
      ['one'],
    );
    assert.equal(JSON.parse(await readFile(join(root, '.sitetiller/last-job.json'), 'utf8')), null);
    assert.deepEqual(await readdir(join(root, '.sitetiller/archived-source-publications')), ['publication-recovery']);
    assert.equal(cms.directory, join(root, '.cms-publication/releases/r1'));
    // The Website serves the server's latest version.
    assert.equal(current.commit, published);
    assert.match(await readFile(join(current.directory, 'index.html'), 'utf8'), /Live/);
    // A second run is refused: the instance already has its published website.
    await assert.rejects(
      exec(process.execPath, [join(repo, 'scripts/instance-adopt.mjs'), deployment], {
        env: { ...process.env, SITETILLER_INSTANCE: root },
      }),
      /\.production exists/,
    );
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
test('OP-06: a production Git given as an SSH address is reached through a mirror with the instance key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-instance-remote-'));
  try {
    await settings(root);
    const instance = {
      ports: { ...ports, publicPreview: 4541 },
      networkMode: 'providers',
      public: {
        editOrigin: 'https://edit.example.cz',
        siteUrl: 'https://example.cz/',
        previewOrigin: 'https://new.example.cz',
        productionGit: 'ssh://site@host.example.cz/git/site/www.git',
        listen: '0.0.0.0',
        retryDeployHook: true,
      },
    };
    const env = await instanceEnvironment(repo, root, instance);
    assert.equal(env.SITETILLER_PRODUCTION_REMOTE, 'ssh://site@host.example.cz/git/site/www.git');
    assert.equal(env.SITETILLER_PRODUCTION_GIT, join(root, '.production', 'remote.git'));
    assert.equal(env.SITETILLER_PRODUCTION_HISTORY_DIR, join(root, '.production', 'remote.git'));
    assert.ok(env.GIT_SSH_COMMAND.includes(JSON.stringify(join(root, 'settings', 'production-git.key'))));
    assert.ok(env.GIT_SSH_COMMAND.includes(JSON.stringify(join(root, 'settings', 'production-git.known_hosts'))));
    assert.match(env.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
    assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
    // The hosting's deploy hooks run on the server, not in the container.
    assert.equal(env.SITETILLER_RETRY_DEPLOY_HOOK, undefined);
    assert.equal(serviceEnvironment(env, instance, 'shell').SITETILLER_PUBLIC_PREVIEW_PORT, '4541');
    assert.equal(serviceEnvironment(env, instance, 'website').SITETILLER_PUBLIC_PREVIEW_PORT, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('OP-07: onto a production Git without SiteTiller versions, adopting publishes the draft as Version 0 only when asked', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sitetiller-instance-adopt-v0-')),
    root = join(base, 'instance'),
    git = join(base, 'site.git');
  try {
    const { Project } = await import('../apps/aistudio/src/project.ts');
    // A hosted website committed by hand: no release tags.
    const hosted = join(base, 'hosted'),
      inHosted = (args) =>
        exec('git', ['-c', 'user.name=Host', '-c', 'user.email=host@example.cz', '-C', hosted, ...args]);
    await mkdir(hosted);
    await exec('git', ['init', '-b', 'main', hosted]);
    await writeFile(join(hosted, 'index.html'), '<!doctype html><title>Hosted</title><h1>Hosted</h1>');
    await inHosted(['add', '.']);
    await inHosted(['commit', '-m', 'Hosted website']);
    const main = (await inHosted(['rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['init', '--bare', '-b', 'main', git]);
    await inHosted(['push', git, 'main']);
    await settings(root);
    await writeFile(
      join(root, 'instance.json'),
      JSON.stringify({ kind: 'sitetiller-next-playground', root: 'C:\old', ports, networkMode: 'providers' }),
    );
    const draft = new Project(join(root, '.sitetiller', 'project'));
    await draft.init(null);
    await draft.write({ 'site/index.html': '<!doctype html><title>Draft</title><h1>Draft</h1>' });
    const step = await draft.commit('Draft');
    await writeFile(join(root, '.sitetiller/config.json'), JSON.stringify({ requests: [], siteUrl: '' }));
    const deployment = join(base, 'deployment.json');
    await writeFile(
      deployment,
      JSON.stringify({
        sourceRoot: 'C:\Dev\play',
        editOrigin: 'https://edit.example.cz',
        siteUrl: 'https://example.cz/',
        productionGit: git,
        publicPreviewPort: 4541,
      }),
    );
    const adopt = () =>
      exec(process.execPath, [join(repo, 'scripts/instance-adopt.mjs'), deployment], {
        env: { ...process.env, SITETILLER_INSTANCE: root },
      });
    // Without the explicit choice nothing is published (the live website would change).
    await assert.rejects(adopt(), /createVersion0FromDraft/);
    assert.equal((await exec('git', ['--git-dir=' + git, 'rev-parse', 'main'])).stdout.trim(), main);
    await rm(join(root, '.production'), { recursive: true, force: true });
    await writeFile(deployment, JSON.stringify({ ...JSON.parse(await readFile(deployment, 'utf8')), createVersion0FromDraft: true }));
    await adopt();
    const config = JSON.parse(await readFile(join(root, '.sitetiller/config.json'), 'utf8')),
      instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'));
    const published = (await exec('git', ['--git-dir=' + git, 'rev-parse', 'main'])).stdout.trim();
    assert.deepEqual(
      config.releases.map((r) => [r.number, r.commit, r.sourceCommit, r.previousCommit]),
      [[0, published, step, main]],
    );
    assert.equal(config.publishedCommit, published);
    // Version 0 = the draft's site on top of the hosted main, whose own files stay.
    assert.equal((await exec('git', ['--git-dir=' + git, 'rev-parse', 'main^'])).stdout.trim(), main);
    assert.equal(
      (await exec('git', ['--git-dir=' + git, 'rev-parse', 'main:site'])).stdout.trim(),
      await draft.git(['rev-parse', step + ':site']),
    );
    assert.match((await exec('git', ['--git-dir=' + git, 'show', 'main:index.html'])).stdout, /Hosted/);
    assert.equal(instance.ports.publicPreview, 4541);
    assert.equal(instance.ports.shell, 4540);
    const tags = await exec('git', ['--git-dir=' + git, 'tag', '--list', 'sitetiller/published/*']);
    assert.equal(tags.stdout.trim(), 'sitetiller/published/v0');
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
test('OP-08: services and adoption run as the owner of the instance; a user with a passwd entry stays as it is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-instance-user-'));
  try {
    const { runAsInstanceOwner, withPasswdEntry } = await import('../scripts/instance-user.mjs'),
      uid = process.getuid?.();
    // Not root (or not POSIX): nothing to switch.
    if (uid !== 0) {
      await runAsInstanceOwner(root);
      assert.equal(process.getuid?.(), uid);
    }
    // The tests run as a user with an /etc/passwd entry (or on Windows): no nss_wrapper.
    assert.deepEqual(await withPasswdEntry({ KEEP: '1' }), { KEEP: '1' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
