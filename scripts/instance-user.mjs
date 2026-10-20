// The user the instance runs as, in a container. A hosting panel may start the container as root (it ignores the
// compose `user`); the services then run as the owner of the instance directory (the domain's user), so every file
// they write belongs to that user. A user id without an /etc/passwd entry gets one through nss_wrapper (when the image
// has it), because Git over SSH refuses to run without it.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Switches this process to the owner of `root` when it runs as root; no-op elsewhere (Windows, already that user).
export async function runAsInstanceOwner(root) {
  if (process.getuid?.() !== 0) return;
  const owner = await stat(root);
  if (owner.uid === 0) return;
  process.setgroups([owner.gid]);
  process.setgid(owner.gid);
  process.setuid(owner.uid);
  Object.assign(process.env, await ownerHome(process.env, owner.uid));
}
// The environment still names root's home (HOME=/root), which the owner cannot write; programs that keep files there
// (Chromium for the browser checks, Git) then fail or hang. The owner gets its own home in the temporary directory.
export async function ownerHome(env, uid, base = tmpdir()) {
  const home = join(base, 'sitetiller-home-' + uid);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const result = { ...env, HOME: home };
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'])
    delete result[name];
  return result;
}
// Adds an /etc/passwd entry for the current user id to `env` when there is none; returns `env` otherwise.
export async function withPasswdEntry(env) {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined) return env;
  const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
  if (passwd.split('\n').some((line) => line.split(':')[2] === String(uid))) return env;
  for (const dir of await readdir('/usr/lib').catch(() => [])) {
    const library = join('/usr/lib', dir, 'libnss_wrapper.so');
    if (!(await readFile(library).then(() => true, () => false))) continue;
    const file = '/tmp/sitetiller-passwd-' + uid;
    await writeFile(file, passwd + 'sitetiller:x:' + uid + ':' + gid + ':SiteTiller:/tmp:/usr/sbin/nologin\n');
    return { ...env, LD_PRELOAD: library, NSS_WRAPPER_PASSWD: file, NSS_WRAPPER_GROUP: '/etc/group' };
  }
  return env;
}
// For the services: the passwd entry only for ssh (through GIT_SSH_COMMAND), not for the whole service. Chromium
// started by the browser checks hangs at start with nss_wrapper preloaded.
export async function withSshPasswdEntry(env, wrapped) {
  wrapped ??= await withPasswdEntry({});
  if (!wrapped.LD_PRELOAD || !env.GIT_SSH_COMMAND) return env;
  const assign = ['LD_PRELOAD', 'NSS_WRAPPER_PASSWD', 'NSS_WRAPPER_GROUP'].map(
    (name) => name + "='" + wrapped[name] + "'",
  );
  return { ...env, GIT_SSH_COMMAND: [...assign, env.GIT_SSH_COMMAND].join(' ') };
}
// Both, for a script about to run Git: switch user, then make child processes (git, ssh) see the passwd entry.
export async function prepareInstanceUser(root) {
  await runAsInstanceOwner(root);
  Object.assign(process.env, await withPasswdEntry(process.env));
}
