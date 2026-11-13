import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootstrapDeployment, bootstrapInstance } from '../scripts/instance-bootstrap.mjs';
import { serviceEnvironment, instanceEnvironment } from '../scripts/instance-env.mjs';
import { readFileSync } from 'node:fs';
import { atomicJson, passwordHash, passwordMatches } from '../packages/settings/index.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
const filesUnder = async (dir) =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
test('OP-11: the first start from variables creates the instance once, keeps the password only as a hash and never reads the variable again; the container listens on all interfaces and checks with the image browser', async () => {
  // The variables: the password alone is not enough, the editor address comes from the hosting's domain.
  assert.equal(bootstrapDeployment({}), null);
  assert.throws(() => bootstrapDeployment({ SITETILLER_ADMIN_PASSWORD: 'x' }), /editor address is missing/);
  assert.throws(
    () => bootstrapDeployment({ SITETILLER_ADMIN_PASSWORD: 'x', SITETILLER_EDIT_ORIGIN: 'https://edit.example.cz/app' }),
    /without a path/,
  );
  assert.throws(
    () => bootstrapDeployment({ SITETILLER_ADMIN_PASSWORD: 'x', RAILWAY_PUBLIC_DOMAIN: 'a.example.app', SITETILLER_LANGUAGE: 'de' }),
    /cs or en/,
  );
  assert.throws(
    () => bootstrapDeployment({ SITETILLER_ADMIN_PASSWORD: 'x', RAILWAY_PUBLIC_DOMAIN: 'a.example.app', SITETILLER_PUBLIC_PREVIEW_PORT: 'x' }),
    /port number/,
  );
  assert.deepEqual(bootstrapDeployment({ SITETILLER_ADMIN_PASSWORD: 'x', RAILWAY_PUBLIC_DOMAIN: 'site-1.example.app' }), {
    editOrigin: 'https://site-1.example.app',
    listen: '0.0.0.0',
    siteUrl: 'https://site-1.example.app/',
  });
  const base = await mkdtemp(join(tmpdir(), 'sitetiller-bootstrap-')),
    root = join(base, 'instance'),
    secret = 'Tajne-heslo-' + Date.now(),
    env = { ...process.env, SITETILLER_ADMIN_PASSWORD: secret, SITETILLER_EDIT_ORIGIN: 'https://edit.example.cz', SITETILLER_PUBLIC_PREVIEW_PORT: '4541' };
  try {
    await mkdir(root);
    // Without the variable an empty directory stays empty (serve.mjs then refuses it, as before).
    const plain = { ...process.env };
    delete plain.SITETILLER_ADMIN_PASSWORD;
    assert.equal(await bootstrapInstance(repo, root, plain), false);
    assert.deepEqual(await readdir(root), []);
    // A directory that is not empty and holds no instance is refused; lost+found of a new volume counts as empty.
    await writeFile(join(root, 'stray.txt'), 'x');
    await assert.rejects(bootstrapInstance(repo, root, env), /not empty and holds no instance/);
    await rm(join(root, 'stray.txt'));
    await mkdir(join(root, 'lost+found'));
    assert.equal(await bootstrapInstance(repo, root, env), true);
    const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8')),
      shared = JSON.parse(await readFile(join(root, 'settings/shared.json'), 'utf8')),
      auth = JSON.parse(await readFile(join(root, 'settings/auth.json'), 'utf8'));
    assert.equal(instance.kind, 'sitetiller-instance');
    assert.equal(instance.public.editOrigin, 'https://edit.example.cz');
    // The container is reached through the host's proxy: the Shell, its public preview and the Website listen on all
    // interfaces, as with Compose, not on loopback only.
    assert.equal(instance.public.listen, '0.0.0.0');
    assert.equal(instance.ports.publicPreview, 4541);
    assert.equal(serviceEnvironment({}, instance, 'shell').EDIT_HOST, '0.0.0.0');
    assert.equal(serviceEnvironment({}, instance, 'shell').SITETILLER_PUBLIC_PREVIEW_PORT, '4541');
    assert.equal(serviceEnvironment({}, instance, 'website').HOST, '0.0.0.0');
    // The image's container defaults reach every instance at runtime, also one created without listen or browser:
    // all interfaces and the image's Chromium for the checks; instance.json overrides them.
    const dockerfile = readFileSync(join(repo, 'deploy/instance.Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes("SITETILLER_LISTEN=0.0.0.0"));
    assert.ok(dockerfile.includes("SITETILLER_BROWSER_EXECUTABLE=/usr/bin/chromium"));
    const bare = { ...instance, public: { editOrigin: instance.public.editOrigin } },
      image = { SITETILLER_LISTEN: '0.0.0.0', SITETILLER_BROWSER_EXECUTABLE: '/usr/bin/chromium' };
    assert.equal(serviceEnvironment(image, bare, 'shell').EDIT_HOST, '0.0.0.0');
    assert.equal(serviceEnvironment({}, bare, 'shell').EDIT_HOST, '127.0.0.1');
    const saved = { ...process.env };
    try {
      Object.assign(process.env, image);
      assert.equal((await instanceEnvironment(repo, root, bare)).SITETILLER_BROWSER_EXECUTABLE, '/usr/bin/chromium');
      const own = await instanceEnvironment(repo, root, { ...bare, public: { ...bare.public, browser: '/opt/chrome' } });
      assert.equal(own.SITETILLER_BROWSER_EXECUTABLE, '/opt/chrome');
    } finally {
      for (const key of Object.keys(image)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    // Internal presentation; the administrator e-mail is optional here.
    assert.equal(instance.public.presentation, undefined);
    assert.equal(shared.adminEmail, undefined);
    assert.equal(passwordMatches(secret, auth.password), true);
    // The password is nowhere in the instance, only its hash.
    for (const file of await filesUnder(root))
      assert.equal((await readFile(file)).includes(secret), false, 'password in ' + file);
    // A second start never reads the variable: the password changed in the app stays valid.
    await atomicJson(join(root, 'settings/auth.json'), { password: passwordHash('Zmenene-heslo') });
    assert.equal(await bootstrapInstance(repo, root, { ...env, SITETILLER_ADMIN_PASSWORD: 'Jine-heslo' }), false);
    const after = JSON.parse(await readFile(join(root, 'settings/auth.json'), 'utf8'));
    assert.equal(passwordMatches('Zmenene-heslo', after.password), true);
    assert.equal(passwordMatches('Jine-heslo', after.password), false);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
