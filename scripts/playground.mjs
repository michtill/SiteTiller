import { normalizeNetworkMode } from './network-policy.mjs';
import { stopOwnedChild, stopVerifiedWindowsProcess } from './processes.mjs';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, cp, stat, open } from 'node:fs/promises';
import { existsSync, closeSync, openSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { atomicJson, passwordHash, readJson } from '../packages/settings/index.mjs';
import { services, instancePaths, instanceEnvironment, serviceEnvironment } from './instance-env.mjs';
import { instancesDirectory } from './instances-dir.mjs';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url))),
  instances = instancesDirectory();
const name = process.env.SITETILLER_INSTANCE_NAME || 'playground';
if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw Error('Invalid instance name');
const root = join(instances, name),
  command = process.argv[2] || 'status';
if (!['init', 'start', 'stop', 'status', 'env', 'network', 'restart'].includes(command))
  throw Error('Use init|start|stop|status|env|network offline|providers|restart aistudio');
if (!relative(instances, root) || relative(instances, root).startsWith('..' + sep))
  throw Error('Invalid isolated root');
const execute = promisify(execFile),
  ports = { shell: 4540, cmstudio: 4510, aistudio: 4520, preview: 4521, publisher: 4523, website: 4512 };
const paths = instancePaths(root);
async function environment() {
  return instanceEnvironment(repo, root, await readJson(join(root, 'instance.json')));
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(resolve));
  });
}
async function ready(port, name, env, child) {
  const route =
    name === 'cmstudio' ? '/api/bootstrap' : name === 'website' ? '/' : name === 'shell' ? '/login' : '/health';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(name + ' exited; see ' + join(root, 'logs', name + '-error.log'));
    try {
      const response = await fetch('http://127.0.0.1:' + port + route, {
        headers: name === 'publisher' ? { Authorization: 'Bearer ' + env.SITETILLER_PUBLISH_TOKEN } : {},
        signal: AbortSignal.timeout(1000),
        redirect: 'manual',
      });
      await response.arrayBuffer();
      if (response.status === (name === 'publisher' ? 404 : 200)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(name + ' did not become ready on ' + port + '; see instance logs');
}
if (command === 'init') {
  if (existsSync(root)) throw Error('Instance already exists; refusing to overwrite ' + root);
  await mkdir(root, { recursive: true });
  for (const folder of ['schema', 'data', 'media/files', 'cms', '.sitetiller', 'settings', 'logs'])
    await mkdir(join(root, folder), { recursive: true });
  const fixture = join(repo, 'fixtures/playground');
  await cp(join(fixture, 'structure.json'), join(root, 'schema/structure.json'));
  await cp(join(fixture, 'pages.json'), join(root, 'data/pages.json'));
  await cp(join(fixture, 'fixture.txt'), join(root, 'media/files/fixture.txt'));
  await atomicJson(join(root, 'instance.json'), {
    kind: 'sitetiller-playground',
    root,
    ports,
    networkMode: 'offline',
  });
  // The administrator e-mail (documentation 2.4) is required; SITETILLER_ADMIN_EMAIL sets it at installation.
  await atomicJson(join(paths.settings, 'shared.json'), {
    name: 'SiteTiller playground',
    theme: 'green',
    ...(process.env.SITETILLER_ADMIN_EMAIL ? { adminEmail: process.env.SITETILLER_ADMIN_EMAIL } : {}),
  });
  const password = randomBytes(18).toString('base64url');
  await atomicJson(join(paths.settings, 'auth.json'), { password: passwordHash(password) });
  await writeFile(join(paths.settings, 'playground-password.txt'), password + '\n', { mode: 0o600 });
  for (const name of ['gateway.token', 'publish.token'])
    await writeFile(join(paths.settings, name), randomBytes(32).toString('hex'), { mode: 0o600 });
  const { Project } = await import('../apps/aistudio/src/project.ts'),
    { captureCmsPublication } = await import('../apps/aistudio/src/cms-publication.ts'),
    { productionSnapshot, storeProductionRelease, deploySite } = await import('../packages/publication/index.ts');
  const draft = new Project(join(paths.data, 'project'));
  await draft.init(null);
  const template = await readFile(join(fixture, 'home.txt'), 'utf8');
  await draft.write({
    'site/index.html':
      '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteTiller playground</title></head><body><main><h1>SiteTiller playground</h1></main></body></html>',
    'site/templates/home.txt': template,
    'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/home.txt' } }),
  });
  await captureCmsPublication(draft, root);
  const sourceCommit = await draft.head();
  const target = new Project(join(paths.production, 'bootstrap'));
  await target.init(null);
  const productionCommit = await productionSnapshot(target, sourceCommit, null, draft);
  await target.git(['update-ref', 'refs/heads/main', productionCommit]);
  await execute('git', ['clone', '--bare', target.root, join(paths.production, 'repository.git')]);
  await storeProductionRelease(
    new Project(join(paths.production, 'repository.git')),
    { number: 0, description: 'Izolovaný výchozí playground', imported: true },
    productionCommit,
    sourceCommit,
  );
  await deploySite(draft, sourceCommit, paths.production);
  await atomicJson(join(paths.data, 'config.json'), {
    slots: [],
    providers: { openai: { key: '' }, anthropic: { key: '' } },
    approvedCommit: sourceCommit,
    publishedCommit: productionCommit,
    requests: [],
    reviewedCommits: [sourceCommit],
    siteUrl: 'http://127.0.0.1:' + ports.website + '/',
    historyInitialized: true,
    lastReviewCommit: sourceCommit,
  });
  console.log('Initialized isolated fixture instance: ' + root);
  console.log('Local password file: ' + join(paths.settings, 'playground-password.txt') + ' (value not displayed)');
} else if (command === 'env') {
  const env = await environment();
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(env).filter(
          ([key]) => /^(CMS_|SITETILLER_|EDIT_|AISTUDIO_|CMSTUDIO_|PREVIEW_)/.test(key) && !/(TOKEN|KEY)/.test(key),
        ),
      ),
      null,
      2,
    ),
  );
} else if (command === 'start') {
  const instance = await readJson(join(root, 'instance.json'));
  if (instance.kind !== 'sitetiller-playground' || resolve(instance.root) !== root)
    throw Error('Not an isolated playground');
  for (const [name, entry] of services) {
    if (!existsSync(join(repo, entry))) throw Error('Missing ' + entry + '; CMStudio must be supplied by its owner.');
    await available(instance.ports[name]);
  }
  const values = Object.values(instance.ports);
  if (
    values.length !== 6 ||
    new Set(values).size !== 6 ||
    values.some((value) => !Number.isInteger(value) || value < 1024 || value > 65535)
  )
    throw Error('Require six distinct explicit nonprivileged ports');
  if (!existsSync(join(repo, 'apps/cmstudio/dist/index.html'))) throw Error('CMStudio build is missing');
  if (!existsSync(join(repo, 'apps/aistudio/dist/index.html')))
    throw Error('AI Studio build is missing (npm run build)');
  const env = await environment(),
    started = [],
    handles = new Map();
  try {
    for (const [name, entry] of services) {
      const log = openSync(join(root, 'logs', name + '.log'), 'a'),
        error = openSync(join(root, 'logs', name + '-error.log'), 'a');
      const child = spawn(
        process.execPath,
        ['--import', pathToFileURL(join(repo, 'scripts/network-policy.mjs')).href, join(repo, entry)],
        {
          cwd: repo,
          env: serviceEnvironment(env, instance, name),
          windowsHide: true,
          detached: true,
          stdio: ['ignore', log, error],
        },
      );
      closeSync(log);
      closeSync(error);
      if (!child.pid) throw Error('Failed to spawn ' + name);
      handles.set(child.pid, child);
      started.push({
        name,
        pid: child.pid,
        entry: join(repo, entry),
        port: instance.ports[name],
        startedAt: new Date().toISOString(),
      });
      child.unref();
      await atomicJson(join(root, 'processes.json'), started);
      await ready(instance.ports[name], name, env, child);
    }
    console.log('Started ' + started.map((s) => s.name + ':' + s.port).join(', '));
    console.log('Shell: http://127.0.0.1:' + instance.ports.shell + '/');
  } catch (e) {
    for (const service of started) {
      try {
        await stopOwnedChild(handles.get(service.pid));
      } catch {}
    }
    await atomicJson(join(root, 'processes.json'), []);
    throw e;
  }
} else if (command === 'network' || command === 'restart') {
  const instance = await readJson(join(root, 'instance.json'));
  if (instance.kind !== 'sitetiller-playground' || resolve(instance.root) !== root)
    throw Error('Not an isolated instance');
  const records = await readJson(join(root, 'processes.json')).catch(() => []),
    controller = records.find((r) => r.name === 'aistudio');
  if (command === 'restart' && process.argv[3] !== 'aistudio') throw Error('Only restart aistudio is supported');
  if (controller) {
    const env = await environment(),
      response = await fetch('http://127.0.0.1:' + instance.ports.aistudio + '/api/state', {
        headers: { 'x-sitetiller-gateway': env.SITETILLER_GATEWAY_TOKEN },
        signal: AbortSignal.timeout(10000),
      });
    if (!response.ok || (await response.json()).busy)
      throw Error('AI controller unavailable or busy; postpone mode change/restart');
  }
  if (command === 'network') {
    instance.networkMode = normalizeNetworkMode(process.argv[3]);
    await atomicJson(join(root, 'instance.json'), instance);
    console.log(
      'Instance network mode: ' + instance.networkMode + '. Apply with: node scripts/playground.mjs restart aistudio',
    );
  } else {
    if (!controller || resolve(controller.entry) !== resolve(join(repo, 'apps/aistudio/src/server.ts')))
      throw Error('No owned AI controller');
    const env = await environment();
    await stopVerifiedWindowsProcess(controller);
    const log = openSync(join(root, 'logs/aistudio.log'), 'a'),
      error = openSync(join(root, 'logs/aistudio-error.log'), 'a');
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(join(repo, 'scripts/network-policy.mjs')).href, controller.entry],
      {
        cwd: repo,
        env: serviceEnvironment(env, instance, 'aistudio'),
        windowsHide: true,
        detached: true,
        stdio: ['ignore', log, error],
      },
    );
    closeSync(log);
    closeSync(error);
    if (!child.pid) throw Error('Controller failed to spawn');
    child.unref();
    await atomicJson(
      join(root, 'processes.json'),
      records.map((r) => (r.name === 'aistudio' ? { ...r, pid: child.pid, startedAt: new Date().toISOString() } : r)),
    );
    await ready(instance.ports.aistudio, 'aistudio', env, child);
    console.log(
      'Only AI controller restarted; shell sessions and five other services preserved. Mode: ' +
        env.SITETILLER_NETWORK_MODE,
    );
  }
} else if (command === 'stop') {
  const records = await readJson(join(root, 'processes.json')).catch(() => []);
  for (const service of records) {
    if (
      !services.some(([name, entry]) => name === service.name && resolve(join(repo, entry)) === resolve(service.entry))
    )
      throw Error('Unknown process record');
    await stopVerifiedWindowsProcess(service);
  }
  await atomicJson(join(root, 'processes.json'), []);
  console.log('Stopped only recorded playground services.');
} else {
  const instance = await readJson(join(root, 'instance.json'));
  for (const [name, port] of Object.entries(instance.ports)) {
    let listening = false;
    try {
      await available(port);
    } catch {
      listening = true;
    }
    console.log(name + ' ' + port + ' ' + (listening ? 'listening' : 'stopped'));
  }
}
