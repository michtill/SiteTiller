import { stopOwnedChild } from '../../scripts/processes.mjs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { readJson, atomicJson } from '../../packages/settings/index.mjs';
const execute = promisify(execFile);
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
export async function isolatedStack({ networkMode = 'offline', controllerImports = [], shellImports = [] } = {}) {
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.NODE_TEST_CONTEXT;
  const repo = resolve('.');
  await mkdir(join(repo, 'work'), { recursive: true });
  const base = await mkdtemp(join(repo, 'work', 'example-real-integration-')),
    root = join(base, 'playground'),
    children = [],
    originNames = ['shell', 'cmstudio', 'aistudio', 'preview', 'publisher', 'website'];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all(children.map(stopOwnedChild));
    if (!resolve(base).startsWith(resolve(join(repo, 'work')) + sep) || !base.includes('example-real-integration-'))
      throw Error('Unsafe fixture cleanup target');
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    await execute(process.execPath, ['scripts/playground.mjs', 'init'], {
      windowsHide: true,
      cwd: repo,
      env: { ...fixtureEnv, SITETILLER_INSTANCES: base, SITETILLER_ADMIN_EMAIL: 'admin@example.test' },
      timeout: 120000,
    });
    const ports = {};
    for (const name of originNames) {
      let port;
      do {
        port = await freePort();
      } while (Object.values(ports).includes(port));
      ports[name] = port;
    }
    await atomicJson(join(root, 'instance.json'), { kind: 'sitetiller-playground', root, ports, networkMode });
    const config = await readJson(join(root, '.sitetiller/config.json'));
    config.siteUrl = 'http://127.0.0.1:' + ports.website + '/';
    await atomicJson(join(root, '.sitetiller/config.json'), config);
    await mkdir(join(root, 'cms'), { recursive: true });
    await atomicJson(join(root, 'cms/settings.json'), {
      name: 'LEGACY MUST NOT WIN',
      subtitle: 'LEGACY',
      theme: 'black',
      autoPublish: true,
    });
    const { stdout } = await execute(process.execPath, ['scripts/playground.mjs', 'env'], {
      windowsHide: true,
      cwd: repo,
      env: { ...fixtureEnv, SITETILLER_INSTANCES: base },
      timeout: 10000,
    });
    const env = {
      ...fixtureEnv,
      ...JSON.parse(stdout),
      HOST: '127.0.0.1',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      SITETILLER_GATEWAY_TOKEN: (await readFile(join(root, 'settings/gateway.token'), 'utf8')).trim(),
      SITETILLER_PUBLISH_TOKEN: (await readFile(join(root, 'settings/publish.token'), 'utf8')).trim(),
    };
    for (const [name, entry] of [
      ['cmstudio', 'apps/cmstudio/server/server.ts'],
      ['aistudio', 'apps/aistudio/src/server.ts'],
      ['preview', 'apps/aistudio/src/preview.ts'],
      ['publisher', 'apps/aistudio/src/publisher.ts'],
      ['website', 'apps/website/server.ts'],
      ['shell', 'apps/shell/server.ts'],
    ]) {
      const child = spawn(
        process.execPath,
        [
          '--import',
          pathToFileURL(join(repo, name === 'aistudio' ? 'scripts/network-policy.mjs' : 'scripts/offline.mjs')).href,
          ...(name === 'aistudio' ? controllerImports : name === 'shell' ? shellImports : []).flatMap((path) => [
            '--import',
            pathToFileURL(join(repo, path)).href,
          ]),
          join(repo, entry),
        ],
        {
          cwd: repo,
          env: { ...env, PORT: String(ports[name]) },
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      child.fixtureError = '';
      child.stderr.on('data', (chunk) => {
        child.fixtureError += chunk.toString();
      });
      children.push(child);
      let started = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error(name + ' exited: ' + child.fixtureError);
        try {
          const c = net.connect(ports[name], '127.0.0.1');
          await new Promise((r, j) => {
            c.once('connect', () => {
              c.destroy();
              r();
            });
            c.once('error', j);
          });
          started = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!started) throw Error(name + ' not ready: ' + child.fixtureError);
    }
    return {
      repo,
      root,
      ports,
      origin: 'http://127.0.0.1:' + ports.shell,
      website: 'http://127.0.0.1:' + ports.website,
      password: (await readFile(join(root, 'settings/playground-password.txt'), 'utf8')).trim(),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
