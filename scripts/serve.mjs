// Runs one instance in the server container (documentation 2.6): this process becomes the Shell, which supervises the
// other services, starts them when they are needed and lets the unused ones sleep. Logs go to standard output with the
// service name. When the Shell stops, the services stop with it and the container restarts.
import { runAsInstanceOwner, withSshPasswdEntry } from './instance-user.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from '../packages/settings/index.mjs';
import { services, instanceEnvironment, serviceEnvironment } from './instance-env.mjs';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = resolve(process.env.SITETILLER_INSTANCE || '/instance'),
  instance = await readJson(join(root, 'instance.json'));
if (instance.kind !== 'sitetiller-instance' || resolve(instance.root) !== root)
  throw Error('Not a SiteTiller instance: ' + root);
// The services run as the owner of the instance (see instance-user.mjs).
await runAsInstanceOwner(root);
const env = await withSshPasswdEntry(await instanceEnvironment(repo, root, instance));
Object.assign(process.env, serviceEnvironment(env, instance, 'shell'), { SITETILLER_SUPERVISE: '1' });
console.log(
  'SiteTiller instance ' + root + ': ' + services.map(([name]) => name + ':' + instance.ports[name]).join(', '),
);
await import(pathToFileURL(join(repo, 'scripts/network-policy.mjs')).href);
await import(pathToFileURL(join(repo, 'apps/shell/server.ts')).href);
