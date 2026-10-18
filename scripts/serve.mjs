// Runs all six services of one instance in the foreground (the server container). Logs go to standard output with
// the service name; when any service stops, the others stop too and the container restarts them together.
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
// A hosting panel runs the container under the domain's user, an id without an /etc/passwd entry. Git over SSH needs
// one, so nss_wrapper (when the image has it) adds the user from a passwd file in /tmp.
async function withPasswdEntry(env) {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined) return env;
  const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
  if (passwd.split('\n').some((line) => line.split(':')[2] === String(uid))) return env;
  for (const dir of await readdir('/usr/lib').catch(() => [])) {
    const library = join('/usr/lib', dir, 'libnss_wrapper.so');
    if (!(await readFile(library).then(() => true, () => false))) continue;
    const file = '/tmp/sitetiller-passwd';
    await writeFile(file, passwd + 'sitetiller:x:' + uid + ':' + gid + ':SiteTiller:/tmp:/usr/sbin/nologin\n');
    return { ...env, LD_PRELOAD: library, NSS_WRAPPER_PASSWD: file, NSS_WRAPPER_GROUP: '/etc/group' };
  }
  return env;
}
Object.assign(env, await withPasswdEntry(env));
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
