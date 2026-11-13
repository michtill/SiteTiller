// The first start from variables (documentation, deployment): a container that starts with an empty instance directory
// and SITETILLER_ADMIN_PASSWORD creates the instance itself, as instance-create.mjs does, so a one-click hosting template
// needs no shell. The variable is read only then: an existing instance is never touched, so a password changed in the
// app stays valid. Without the variable nothing changes (serve.mjs refuses a directory that is not an instance).
import { access, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Variables → deployment.json for instance-create.mjs; null when there is nothing to create.
export function bootstrapDeployment(env) {
  if (!env.SITETILLER_ADMIN_PASSWORD) return null;
  const editOrigin =
    env.SITETILLER_EDIT_ORIGIN || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : '');
  if (!editOrigin)
    throw Error('First start: the editor address is missing (SITETILLER_EDIT_ORIGIN or RAILWAY_PUBLIC_DOMAIN)');
  const origin = new URL(editOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search)
    throw Error('First start: SITETILLER_EDIT_ORIGIN must be an http(s) address without a path');
  if (env.SITETILLER_LANGUAGE !== undefined && !['cs', 'en'].includes(env.SITETILLER_LANGUAGE))
    throw Error('First start: SITETILLER_LANGUAGE is cs or en');
  return {
    editOrigin: origin.origin,
    siteUrl: env.SITETILLER_SITE_URL || origin.origin + '/',
    ...(env.SITETILLER_PREVIEW_ORIGIN ? { previewOrigin: env.SITETILLER_PREVIEW_ORIGIN } : {}),
    ...(env.SITETILLER_ADMIN_EMAIL ? { adminEmail: env.SITETILLER_ADMIN_EMAIL } : {}),
    ...(env.SITETILLER_LANGUAGE ? { language: env.SITETILLER_LANGUAGE } : {}),
  };
}
// Creates the instance in `root` when it has none and the variables ask for it. Returns true when it created one.
export async function bootstrapInstance(repo, root, env = process.env) {
  if (await access(join(root, 'instance.json')).then(() => true, () => false)) return false;
  const deployment = bootstrapDeployment(env);
  if (!deployment) return false;
  const present = (await readdir(root).catch(() => [])).filter((name) => name !== 'lost+found');
  if (present.length)
    throw Error('First start: ' + root + ' is not empty and holds no instance; nothing was created');
  const file = join(tmpdir(), 'sitetiller-bootstrap-' + randomBytes(6).toString('hex') + '.json');
  try {
    await writeFile(file, JSON.stringify(deployment), { mode: 0o600 });
    const child = { ...env, SITETILLER_INSTANCE: root, SITETILLER_CREATE_PASSWORD: env.SITETILLER_ADMIN_PASSWORD };
    delete child.SITETILLER_ADMIN_PASSWORD;
    const { stdout } = await exec(process.execPath, [join(repo, 'scripts/instance-create.mjs'), file], { env: child });
    process.stdout.write(stdout);
  } finally {
    await rm(file, { force: true });
  }
  return true;
}
