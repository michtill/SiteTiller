// The user the instance runs as, in a container. A hosting panel may start the container as root (it ignores the
// compose `user`); the services then run as the owner of the instance directory (the domain's user), so every file
// they write belongs to that user. A user id without an /etc/passwd entry gets one through nss_wrapper (when the image
// has it), because Git over SSH refuses to run without it.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Switches this process to the owner of `root` when it runs as root; no-op elsewhere (Windows, already that user).
export async function runAsInstanceOwner(root) {
  if (process.getuid?.() !== 0) return;
  const owner = await stat(root);
  if (owner.uid === 0) return;
  process.setgroups([owner.gid]);
  process.setgid(owner.gid);
  process.setuid(owner.uid);
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
// Both, for a script about to run Git: switch user, then make child processes (git, ssh) see the passwd entry.
export async function prepareInstanceUser(root) {
  await runAsInstanceOwner(root);
  Object.assign(process.env, await withPasswdEntry(process.env));
}
