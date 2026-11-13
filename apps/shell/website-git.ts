// Settings → Addresses and sharing → Website presentation (documentation 2.4, 7.7): the key the instance writes to the
// website Git with, the server's host key the owner confirms, and a check that the key may write there.
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sshString = (value: Buffer | string) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};
const uint32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
};
// A new ed25519 key in the OpenSSH formats: the private key file and the public key line.
export function newKey(comment = 'sitetiller') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'),
    pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'),
    seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url'),
    blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]),
    check = randomBytes(4).readUInt32BE();
  let secret = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let i = 1; (secret.length + padding.length) % 8; i++) padding.push(i);
  secret = Buffer.concat([secret, Buffer.from(padding)]);
  const body = Buffer.concat([
      Buffer.from('openssh-key-v1\0'),
      sshString('none'),
      sshString('none'),
      sshString(''),
      uint32(1),
      sshString(blob),
      sshString(secret),
    ]).toString('base64'),
    lines = body.match(/.{1,70}/g)!.join('\n');
  return {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + lines + '\n-----END OPENSSH PRIVATE KEY-----\n',
    publicKey: 'ssh-ed25519 ' + blob.toString('base64') + ' ' + comment,
  };
}
// The SHA256 fingerprint of a public key line or of a known_hosts line, as ssh shows it.
export function fingerprint(line: string) {
  const parts = line.trim().split(/\s+/),
    key = parts.find((part, i) => i > 0 && /^AAAA/.test(part)) || parts[1] || '';
  return 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
}
const keyFile = (settings: string) => join(settings, 'website-git.key'),
  hostsFile = (settings: string) => join(settings, 'website-git.known_hosts');
export async function publicKey(settings: string) {
  return (await readFile(keyFile(settings) + '.pub', 'utf8').catch(() => '')).trim();
}
export async function createKey(settings: string, comment: string) {
  const key = newKey(comment);
  await writeFile(keyFile(settings), key.privateKey, { mode: 0o600 });
  await chmod(keyFile(settings), 0o600);
  await writeFile(keyFile(settings) + '.pub', key.publicKey + '\n', { mode: 0o644 });
  return key.publicKey;
}
// A website Git address the Settings accept: ssh://…, user@host:path or an absolute local path; never an option.
export function validWebsiteGit(address: string) {
  return (
    address.length <= 500 &&
    !/[\s\0]/.test(address) &&
    !address.startsWith('-') &&
    (/^ssh:\/\/[^/\s]+\/./.test(address) || /^[\w.-]+@[\w.-]+:[^/].*/.test(address) || /^(\/|[A-Za-z]:[\\/])/.test(address))
  );
}
export function validBranch(branch: string) {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(branch) && !branch.startsWith('-') && !branch.includes('..') && !branch.endsWith('/');
}
// The SSH server of an address, or null for a local path.
export function sshHost(address: string) {
  const url = /^ssh:\/\//.test(address) ? new URL(address) : null;
  if (url) return { host: url.hostname, port: Number(url.port) || 22 };
  const scp = address.match(/^[\w.-]+@([\w.-]+):/);
  return scp ? { host: scp[1], port: 22 } : null;
}
const hostPattern = (host: { host: string; port: number }) => (host.port === 22 ? host.host : '[' + host.host + ']:' + host.port);
// The host keys the server offers now (ssh-keyscan), each with its fingerprint.
export async function scanHost(host: { host: string; port: number }) {
  const { stdout } = await exec('ssh-keyscan', ['-T', '10', '-p', String(host.port), '--', host.host], { timeout: 20000 });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => ({ line, fingerprint: fingerprint(line) }));
}
// Whether the confirmed host keys already hold this server.
export async function knownHost(settings: string, host: { host: string; port: number }) {
  const lines = (await readFile(hostsFile(settings), 'utf8').catch(() => '')).split('\n');
  return lines.some((line) => line.split(/\s+/)[0]?.split(',').includes(hostPattern(host)));
}
// Stores the scanned keys of the server, but only those whose fingerprints the owner saw and confirmed.
export async function trustHost(settings: string, host: { host: string; port: number }, confirmed: string[]) {
  const offered = await scanHost(host),
    accepted = offered.filter((key) => confirmed.includes(key.fingerprint));
  if (!accepted.length || accepted.length !== offered.length) throw Error('host-key-changed');
  const kept = (await readFile(hostsFile(settings), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim() && !line.split(/\s+/)[0]?.split(',').includes(hostPattern(host)));
  await writeFile(hostsFile(settings), [...kept, ...accepted.map((key) => key.line)].join('\n') + '\n', { mode: 0o600 });
}
// Tries a write that changes nothing (git push --dry-run of a new branch name) with the website key.
export async function checkWrite(settings: string, address: string) {
  const temp = await mkdtemp(join(tmpdir(), 'sitetiller-website-check-'));
  try {
    const git = (args: string[], env: Record<string, string> = {}) =>
      exec('git', args, { cwd: temp, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    await git(['init', '-q', '-b', 'main']);
    await git(['-c', 'user.name=SiteTiller', '-c', 'user.email=sitetiller@localhost', 'commit', '-q', '--allow-empty', '-m', 'check']);
    const ssh = sshHost(address)
      ? {
          GIT_SSH_COMMAND: [
            'ssh -i',
            JSON.stringify(keyFile(settings)),
            '-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes',
            '-o UserKnownHostsFile=' + JSON.stringify(hostsFile(settings)),
          ].join(' '),
        }
      : {};
    await git(['push', '--dry-run', '--porcelain', address, 'HEAD:refs/heads/sitetiller-check-' + randomBytes(4).toString('hex')], ssh);
  } catch (e: any) {
    throw Object.assign(Error('website-git-refused'), { detail: String(e.stderr || e.message || '').trim().slice(0, 500) });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
