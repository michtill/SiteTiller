import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { readJson } from '../../packages/settings/index.mjs';
import { services, instanceEnvironment, serviceEnvironment } from '../../scripts/instance-env.mjs';
import { withSshPasswdEntry } from '../../scripts/instance-user.mjs';
import { supervise } from './supervisor.ts';
// The services of this instance under the Shell (documentation 2.6). The Website sleeps only when the public website
// is hosted elsewhere (external presentation); otherwise it is the public website and never sleeps.
export async function superviseInstance() {
  const repo = resolve(fileURLToPath(new URL('../..', import.meta.url))),
    root = resolve(process.env.SITETILLER_INSTANCE_ROOT || ''),
    instance = await readJson(join(root, 'instance.json')),
    listen = instance.public?.listen || '127.0.0.1',
    logs = process.env.SITETILLER_SERVICE_LOGS;
  const environment = async (name: string) => {
    const current = await readJson(join(root, 'instance.json'));
    const env = serviceEnvironment(await withSshPasswdEntry(await instanceEnvironment(repo, root, current)), current, name);
    // Only the Shell supervises.
    delete env.SITETILLER_SUPERVISE;
    delete env.SITETILLER_SERVICE_LOGS;
    return env;
  };
  const output = (name: string, child: ChildProcess) => {
    if (logs) {
      child.stdout!.pipe(createWriteStream(join(logs, name + '.log'), { flags: 'a' }));
      child.stderr!.pipe(createWriteStream(join(logs, name + '-error.log'), { flags: 'a' }));
      return;
    }
    for (const stream of [child.stdout!, child.stderr!])
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) if (line) process.stdout.write('[' + name + '] ' + line + '\n');
      });
  };
  const managed = services
    .filter(([name]: [string, string]) => name !== 'shell')
    .map(([name, entry]: [string, string]) => ({
      name,
      entry,
      port: Number(instance.ports[name]),
      host: name === 'website' ? listen : '127.0.0.1',
      sleeps: name !== 'website' || instance.public?.presentation === 'external',
      // The AI Studio keeps working after it answered (a request, a publication, a save): it sleeps only when idle.
      ...(name === 'aistudio'
        ? {
            idle: async (port: number) => {
              const response = await fetch('http://127.0.0.1:' + port + '/api/state', {
                headers: {
                  'x-sitetiller-gateway': process.env.SITETILLER_GATEWAY_TOKEN || '',
                  origin: 'http://127.0.0.1:' + port,
                },
                signal: AbortSignal.timeout(10000),
              });
              if (!response.ok) return false;
              return !(await response.json()).busy;
            },
          }
        : {}),
    }));
  return supervise({
    repo,
    services: managed,
    environment,
    output,
    recordFile: join(root, 'supervised.json'),
    checkEvery: Number(process.env.SITETILLER_SLEEP_CHECK_MS) || 30000,
    // Settings → Interface: sleep after 5, 15 (default), 30 or 60 minutes, or never (0). The tests shorten it.
    idleTime: async () => {
      if (process.env.SITETILLER_SLEEP_AFTER_MS) return Number(process.env.SITETILLER_SLEEP_AFTER_MS);
      const shared = await readJson(join(root, 'settings/shared.json')).catch(() => ({}));
      return (Number.isInteger(shared.sleepMinutes) ? shared.sleepMinutes : 15) * 60000;
    },
  });
}
