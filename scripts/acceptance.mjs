// The local acceptance instance for blind acceptance tests: a Playground-like instance named "acceptance" beside the
// Playground, with invented data, its own password and its own ports. The Playground and its data are never touched.
//   node scripts/acceptance.mjs reset|start|stop|status
// reset stops it and creates it again from scratch (a new password in settings/playground-password.txt).
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, readJson } from '../packages/settings/index.mjs';
import { instancesDirectory } from './instances-dir.mjs';
const execute = promisify(execFile),
  repo = resolve(fileURLToPath(new URL('..', import.meta.url))),
  name = 'acceptance',
  root = join(instancesDirectory(), name),
  ports = { shell: 4740, cmstudio: 4710, aistudio: 4720, preview: 4721, publisher: 4723, website: 4712 },
  command = process.argv[2] || 'status';
if (!['reset', 'start', 'stop', 'status'].includes(command)) throw Error('Use reset|start|stop|status');
const playground = async (...args) => {
  const { stdout } = await execute(process.execPath, [join(repo, 'scripts/playground.mjs'), ...args], {
    cwd: repo,
    env: { ...process.env, SITETILLER_INSTANCE_NAME: name },
    windowsHide: true,
    timeout: 180000,
  });
  process.stdout.write(stdout);
};
if (command !== 'reset') await playground(command);
else {
  if (existsSync(root)) {
    // Only an instance this script made is removed.
    const instance = await readJson(join(root, 'instance.json'));
    if (instance.kind !== 'sitetiller-playground' || resolve(instance.root) !== root || instance.ports.shell !== ports.shell)
      throw Error('Not the acceptance instance; refusing to remove ' + root);
    await playground('stop');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  await execute(process.execPath, [join(repo, 'scripts/playground.mjs'), 'init'], {
    cwd: repo,
    env: { ...process.env, SITETILLER_INSTANCE_NAME: name, SITETILLER_ADMIN_EMAIL: 'spravce@example.test' },
    windowsHide: true,
    timeout: 180000,
  });
  const instance = await readJson(join(root, 'instance.json'));
  await atomicJson(join(root, 'instance.json'), { ...instance, ports });
  const config = await readJson(join(root, '.sitetiller/config.json'));
  await atomicJson(join(root, '.sitetiller/config.json'), {
    ...config,
    siteUrl: 'http://127.0.0.1:' + ports.website + '/',
  });
  const shared = await readJson(join(root, 'settings/shared.json'));
  await atomicJson(join(root, 'settings/shared.json'), { ...shared, name: 'SiteTiller přijímací test' });
  console.log('Acceptance instance created: ' + root);
  console.log('Password file: ' + join(root, 'settings/playground-password.txt') + ' (value not displayed)');
  console.log('Start with: node scripts/acceptance.mjs start, then http://127.0.0.1:' + ports.shell + '/');
}
