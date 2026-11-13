import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { passwordHash } from '../packages/settings/index.mjs';
import { instanceEnvironment, serviceEnvironment, websitePresentation } from '../scripts/instance-env.mjs';
import { newKey, fingerprint, validWebsiteGit, validBranch, sshHost } from '../apps/shell/website-git.ts';
import { supervise } from '../apps/shell/supervisor.ts';
const exec = promisify(execFile),
  repo = fileURLToPath(new URL('..', import.meta.url)),
  ports = { shell: 4540, cmstudio: 4510, aistudio: 4520, preview: 4521, publisher: 4523, website: 4512 };
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test('OP-14: the website presentation switches in Settings with the instance key as a deploy key, saves only after a passed check and leaves the installed mode otherwise', async () => {
  // Addresses and branches the Settings accept; never an option for git.
  for (const ok of ['git@github.com:user/web.git', 'ssh://git@host.example.cz/git/web.git', '/srv/git/web.git', 'C:\\git\\web.git'])
    assert.equal(validWebsiteGit(ok), true, ok);
  for (const wrong of ['--upload-pack=touch x', 'ext::sh -c x', 'https://github.com/u/w.git', 'git@github.com:/x y'])
    assert.equal(validWebsiteGit(wrong), false, wrong);
  assert.equal(validBranch('main'), true);
  for (const wrong of ['-x', 'a..b', 'a b', ''])
    assert.equal(validBranch(wrong), false, wrong);
  assert.deepEqual(sshHost('git@github.com:user/web.git'), { host: 'github.com', port: 22 });
  assert.deepEqual(sshHost('ssh://git@host.example.cz:2222/web.git'), { host: 'host.example.cz', port: 2222 });
  assert.equal(sshHost('/srv/git/web.git'), null);
  // The key: OpenSSH formats; ssh-keygen (where installed) derives the same public key from the private file.
  const key = newKey('sitetiller@edit.example.cz');
  assert.match(key.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.match(key.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* sitetiller@edit\.example\.cz$/);
  assert.match(fingerprint(key.publicKey), /^SHA256:[A-Za-z0-9+/]{43}$/);
  const base = await mkdtemp(join(tmpdir(), 'sitetiller-presentation-')),
    root = join(base, 'instance'),
    git = join(base, 'web.git'),
    port = await freePort(),
    origin = 'http://127.0.0.1:' + port;
  let shell;
  try {
    const keygen = await exec('ssh-keygen', ['-?']).then(
      () => true,
      (e) => e.code !== 'ENOENT',
    );
    if (keygen) {
      await writeFile(join(base, 'k'), key.privateKey, { mode: 0o600 });
      const derived = (await exec('ssh-keygen', ['-y', '-f', join(base, 'k')])).stdout.trim().split(' ').slice(0, 2).join(' ');
      assert.equal(derived, key.publicKey.split(' ').slice(0, 2).join(' '));
    }
    await mkdir(join(root, 'settings'), { recursive: true });
    await exec('git', ['init', '--bare', '-q', '-b', 'main', git]);
    const instance = { kind: 'sitetiller-instance', root, ports, public: { editOrigin: origin, siteUrl: 'https://example.cz/' } };
    await writeFile(join(root, 'instance.json'), JSON.stringify(instance));
    await writeFile(join(root, 'settings/gateway.token'), 'g'.repeat(64));
    await writeFile(join(root, 'settings/publish.token'), 'p'.repeat(64));
    await writeFile(join(root, 'settings/auth.json'), JSON.stringify({ password: passwordHash('fixture-password-12') }));
    await writeFile(join(root, 'settings/shared.json'), JSON.stringify({ name: 'Modrý Kocour', theme: 'light', language: 'en' }));
    shell = spawn(process.execPath, [join(repo, 'apps/shell/server.ts')], {
      cwd: repo,
      env: { ...process.env, PORT: String(port), EDIT_ORIGIN: origin, SITETILLER_INSTANCE_ROOT: root, SITETILLER_GATEWAY_TOKEN: 'g'.repeat(64) },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/login')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const login = await fetch(origin + '/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=fixture-password-12',
        redirect: 'manual',
      }),
      cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (fields) =>
      fetch(origin + '/settings/addresses', {
        method: 'POST',
        headers: { cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ returnTo: '/', ...fields }).toString(),
      });
    const shared = async () => JSON.parse(await readFile(join(root, 'settings/shared.json'), 'utf8'));
    // The installed mode: internal, nothing switched.
    const first = await (await fetch(origin + '/settings/addresses', { headers: { cookie } })).text();
    assert.match(first, /name="presentation" value="internal" checked/);
    assert.match(first, /Installed: Internal/);
    // The key: shown for copying; the private one only in settings/website-git.key; a second one only after ticking.
    const created = await (await post({ action: 'presentationKey' })).text();
    const shown = created.match(/class="share-url website-key" value="([^"]+)"/)[1];
    assert.match(shown, /^ssh-ed25519 /);
    assert.equal((await readFile(join(root, 'settings/website-git.key.pub'), 'utf8')).trim(), shown);
    assert.match(await readFile(join(root, 'settings/website-git.key'), 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
    assert.equal((await post({ action: 'presentationKey' })).status, 409);
    const replaced = await (await post({ action: 'presentationKey', confirm: 'yes' })).text();
    assert.notEqual(replaced.match(/class="share-url website-key" value="([^"]+)"/)[1], shown);
    // Saving the external presentation needs a passed check of exactly this Git and branch.
    const external = { presentation: 'external', websiteGit: git, websiteBranch: 'main' };
    assert.equal((await post({ action: 'presentationSave', ...external })).status, 422);
    assert.equal((await post({ action: 'presentationVerify', ...external, websiteGit: '--upload-pack=x' })).status, 422);
    assert.equal((await post({ action: 'presentationVerify', ...external, websiteGit: join(base, 'missing.git') })).status, 422);
    const checked = await post({ action: 'presentationVerify', ...external });
    assert.equal(checked.status, 200);
    assert.match(await checked.text(), /Connection checked/);
    // The check wrote nothing to the website Git.
    assert.equal((await exec('git', ['--git-dir=' + git, 'for-each-ref'])).stdout.trim(), '');
    assert.equal((await post({ action: 'presentationSave', ...external, websiteBranch: 'other' })).status, 422);
    assert.equal((await post({ action: 'presentationSave', ...external })).status, 200);
    assert.deepEqual([(await shared()).presentation, (await shared()).websiteGit, (await shared()).websiteBranch], ['external', git, 'main']);
    // The services start with the switched presentation: the website Git, the Publisher checks the public address.
    const env = await instanceEnvironment(repo, root, instance);
    assert.equal(env.SITETILLER_WEBSITE_GIT, git);
    assert.equal(env.SITETILLER_PRESENTATION, 'external');
    assert.equal(serviceEnvironment(env, instance, 'publisher').SITETILLER_WWW_URL, 'https://example.cz/');
    assert.match(await (await fetch(origin + '/settings/addresses', { headers: { cookie } })).text(), /name="presentation" value="external" checked/);
    // An SSH website Git switched in the app uses the instance's own key and confirmed host keys.
    const ssh = websitePresentation(instance, { presentation: 'external', websiteGit: 'git@github.com:user/web.git' });
    assert.deepEqual(ssh, { external: true, websiteGit: 'git@github.com:user/web.git', websiteBranch: 'main', key: 'website-git' });
    await writeFile(join(root, 'settings/shared.json'), JSON.stringify({ ...(await shared()), websiteGit: 'git@github.com:user/web.git' }));
    const sshEnv = await instanceEnvironment(repo, root, instance);
    assert.match(sshEnv.GIT_SSH_COMMAND, /website-git\.key/);
    assert.match(sshEnv.GIT_SSH_COMMAND, /website-git\.known_hosts/);
    assert.match(sshEnv.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
    // Back to internal: the website runs in the instance again; the key and the address stay for next time.
    assert.equal((await post({ action: 'presentationSave', presentation: 'internal' })).status, 200);
    assert.equal((await shared()).presentation, 'internal');
    assert.equal((await shared()).websiteGit, 'git@github.com:user/web.git');
    assert.equal((await instanceEnvironment(repo, root, instance)).SITETILLER_WEBSITE_GIT, undefined);
    assert.ok(await readFile(join(root, 'settings/website-git.key'), 'utf8'));
    // Without a switch in the app the installed mode applies, so today's instances do not change.
    const installed = { ...instance, public: { ...instance.public, presentation: 'external', websiteGit: 'ssh://site@host.example.cz/www.git' } };
    assert.deepEqual(websitePresentation(installed, {}), {
      external: true,
      websiteGit: 'ssh://site@host.example.cz/www.git',
      websiteBranch: 'main',
      key: 'production-git',
    });
    assert.equal(websitePresentation(installed, { name: 'x' }).key, 'production-git');
  } finally {
    if (shell) {
      const exited = new Promise((r) => shell.once('exit', r));
      shell.kill();
      await exited;
    }
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
test('OP-14: after the switch the supervisor restarts a service with the new environment and the Website may sleep or stays up', async () => {
  const port = await freePort();
  let generation = 1;
  const supervisor = await supervise({
    repo: resolve('.'),
    services: [{ name: 'website', entry: 'test/fixtures/sleepy-service.mjs', port, host: '127.0.0.1', sleeps: false }],
    environment: async () => ({ ...process.env, GENERATION: String(generation) }),
    idleTime: async () => 300,
    output: () => {},
    checkEvery: 100,
  });
  const pid = async () => Number(await (await fetch('http://127.0.0.1:' + port + '/')).text());
  try {
    // Internal: up at once and never asleep.
    for (let i = 0; i < 100 && supervisor.asleep('website'); i++) await new Promise((r) => setTimeout(r, 50));
    const first = await pid();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(supervisor.asleep('website'), false);
    // Switched to external: restarted (a new process, a fresh environment) and it may sleep.
    generation = 2;
    await supervisor.restart('website', true);
    assert.equal(supervisor.asleep('website'), true);
    const second = await pid();
    assert.notEqual(second, first);
    for (let i = 0; i < 100 && !supervisor.asleep('website'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(supervisor.asleep('website'), true);
    // Back to internal: it starts again at once and stays up.
    await supervisor.restart('website', false);
    assert.equal(supervisor.asleep('website'), false);
  } finally {
    await supervisor.stop();
  }
});
