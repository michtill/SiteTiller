import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { resolve } from 'node:path';
import { supervise } from '../apps/shell/supervisor.ts';
// The Shell as the supervisor (documentation 2.6), with an invented service.
const freePort = () =>
  new Promise((done) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = async (condition, ms = 15000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('timeout');
};
async function service(options = {}) {
  const port = await freePort();
  const supervisor = await supervise({
    repo: resolve('.'),
    services: [{ name: 'sleepy', entry: 'test/fixtures/sleepy-service.mjs', port, host: '127.0.0.1', sleeps: true, ...options }],
    environment: async () => ({ ...process.env, ...(options.env || {}) }),
    idleTime: async () => options.idleTime ?? 400,
    output: () => {},
    checkEvery: 100,
  });
  return { port, supervisor, get: (path = '/') => fetch('http://127.0.0.1:' + port + path) };
}
test('OP-10: a sleeping service starts with the first request, sleeps after the idle time and its process ends; the next request starts it again', async () => {
  const { supervisor, get } = await service();
  try {
    assert.equal(supervisor.asleep('sleepy'), true);
    const first = Number(await (await get()).text());
    assert.ok(alive(first));
    assert.equal(supervisor.asleep('sleepy'), false);
    await wait(() => supervisor.asleep('sleepy'));
    await wait(() => !alive(first));
    const second = Number(await (await get()).text());
    assert.notEqual(second, first);
  } finally {
    await supervisor.stop();
  }
});
test('OP-10: a service that works or has an open connection does not sleep; Never keeps it up', async () => {
  let working = true;
  const busy = await service({ idle: async () => !working });
  const held = await service();
  const never = await service({ idleTime: 0 });
  try {
    await (await busy.get()).text();
    const hold = held.get('/hold');
    await wait(() => !held.supervisor.asleep('sleepy'));
    await (await never.get()).text();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(busy.supervisor.asleep('sleepy'), false);
    assert.equal(held.supervisor.asleep('sleepy'), false);
    assert.equal(never.supervisor.asleep('sleepy'), false);
    // Done: both sleep.
    working = false;
    await held.get('/release');
    assert.equal(await (await hold).text(), 'released');
    await wait(() => busy.supervisor.asleep('sleepy') && held.supervisor.asleep('sleepy'));
  } finally {
    await Promise.all([busy.supervisor.stop(), held.supervisor.stop(), never.supervisor.stop()]);
  }
});
test('OP-10: a service that does not start ends the request with an exact error naming it; stopping the supervisor ends every service', async () => {
  const broken = await service({ env: { FIXTURE_FAIL: '1' } });
  const running = await service();
  try {
    const response = await broken.get();
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Služba sleepy se nespustila/);
    const pid = Number(await (await running.get()).text());
    await running.supervisor.stop();
    await wait(() => !alive(pid));
  } finally {
    await broken.supervisor.stop();
  }
});
test(
  'OP-10: a whole instance runs under the Shell: a sleeping studio shows Waking up, wakes, sleeps again; the Website of an internal presentation never sleeps; stop ends everything',
  { timeout: 240000 },
  async () => {
    const { mkdtemp, rm, readFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { readJson, atomicJson } = await import('../packages/settings/index.mjs');
    const execute = promisify(execFile);
    await mkdir(resolve('work'), { recursive: true });
    const base = await mkdtemp(join(resolve('work'), 'example-real-integration-')),
      root = join(base, 'playground'),
      env = {
        ...process.env,
        SITETILLER_INSTANCES: base,
        SITETILLER_ADMIN_EMAIL: 'admin@example.test',
        SITETILLER_SLEEP_AFTER_MS: '1500',
        SITETILLER_SLEEP_CHECK_MS: '200',
      };
    delete env.NODE_TEST_CONTEXT;
    const playground = (...args) =>
      execute(process.execPath, ['scripts/playground.mjs', ...args], { env, windowsHide: true, timeout: 180000 });
    try {
      await playground('init');
      const ports = {};
      for (const name of ['shell', 'cmstudio', 'aistudio', 'preview', 'publisher', 'website']) ports[name] = await freePort();
      const instance = await readJson(join(root, 'instance.json'));
      await atomicJson(join(root, 'instance.json'), { ...instance, ports });
      await playground('start');
      const origin = 'http://127.0.0.1:' + ports.shell,
        password = (await readFile(join(root, 'settings/playground-password.txt'), 'utf8')).trim(),
        login = await fetch(origin + '/login', {
          method: 'POST',
          headers: { Origin: origin },
          body: new URLSearchParams({ password }),
          redirect: 'manual',
        }),
        cookie = login.headers.get('set-cookie').split(';')[0];
      const running = async () => Object.keys(await readJson(join(root, 'supervised.json')).catch(() => ({})));
      // Only the Shell runs; the Website of the local (internal) presentation starts at once.
      await wait(async () => (await running()).includes('website'), 60000);
      assert.equal((await running()).includes('cmstudio'), false);
      // The studio's page says it is waking up and loads again; meanwhile the studio starts.
      const waking = await fetch(origin + '/content/', { headers: { Cookie: cookie, 'Sec-Fetch-Dest': 'iframe' } });
      assert.match(await waking.text(), /Probouzím…/);
      await wait(async () => (await running()).includes('cmstudio'), 60000);
      assert.equal((await fetch(origin + '/content/api/bootstrap', { headers: { Cookie: cookie } })).status, 200);
      // Idle: it sleeps and its process ends; the Website does not.
      const pid = (await readJson(join(root, 'supervised.json'))).cmstudio.pid;
      await wait(async () => !(await running()).includes('cmstudio'), 60000);
      await wait(() => !alive(pid));
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal((await running()).includes('website'), true);
      // An API request just waits for it.
      assert.equal((await fetch(origin + '/content/api/bootstrap', { headers: { Cookie: cookie } })).status, 200);
      const pids = Object.values(await readJson(join(root, 'supervised.json'))).map((r) => r.pid);
      await playground('stop');
      for (const each of pids) await wait(() => !alive(each));
    } finally {
      await playground('stop').catch(() => {});
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
