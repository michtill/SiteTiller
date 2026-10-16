// Runs all six services of one instance in the foreground (the server container). Logs go to standard output with
// the service name; when any service stops, the others stop too and the container restarts them together.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from '../packages/settings/index.mjs';
import { services, instanceEnvironment, serviceEnvironment } from './instance-env.mjs';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = resolve(process.env.SITETILLER_INSTANCE || '/instance'),
  instance = await readJson(join(root, 'instance.json'));
if (instance.kind !== 'sitetiller-next-instance' || resolve(instance.root) !== root)
  throw Error('Not a SiteTiller instance: ' + root);
const env = await instanceEnvironment(repo, root, instance),
  children = new Map();
let stopping = false,
  exitCode = 1;
function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 5000).unref();
  if (!children.size) process.exit(code);
}
for (const [name, entry] of services) {
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(join(repo, 'scripts/network-policy.mjs')).href, join(repo, entry)],
    { cwd: repo, env: serviceEnvironment(env, instance, name), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line) process.stdout.write('[' + name + '] ' + line + '\n');
    });
  child.on('exit', (code, signal) => {
    children.delete(name);
    process.stdout.write('[' + name + '] exited ' + (signal || code) + '\n');
    if (!children.size && stopping) process.exit(exitCode);
    stop(1);
  });
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stop(0);
  });
console.log(
  'SiteTiller instance ' + root + ': ' + services.map(([name]) => name + ':' + instance.ports[name]).join(', '),
);
