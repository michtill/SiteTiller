import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const gateway = 'fixture-gateway-token';
test('AI-10: a running request can be stopped and leaves the draft unchanged', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-stop-api-')),
    port = 22200 + Math.floor(Math.random() * 100),
    origin = 'http://127.0.0.1:' + port;
  const headers = { Origin: origin, 'x-sitetiller-gateway': gateway, 'Content-Type': 'application/json' };
  const post = (path: string, body: any) =>
    fetch(origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const state = async () =>
    (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': gateway } })).json()) as any;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/provider-server.mjs', import.meta.url))], {
    windowsHide: true,
    env: {
      ...process.env,
      SITETILLER_DATA_DIR: data,
      HOST: '127.0.0.1',
      PORT: String(port),
      SITETILLER_ORIGIN: origin,
      SITETILLER_INITIAL_SITE: 'seed',
    },
    stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await fetch(origin + '/health')).ok;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    // Nothing runs yet, so there is nothing to stop.
    assert.equal((await post('run/stop', {})).status, 409);
    const before = (await state()).head;
    assert.equal((await post('run', { prompt: 'Fixture slow provider' })).status, 202);
    // The request waits for the slow provider; stopping it ends the request at once.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await state()).job.status, 'running');
    const started = Date.now();
    assert.equal((await post('run/stop', {})).status, 202);
    let stopped: any;
    for (let i = 0; i < 100; i++) {
      stopped = await state();
      if (!stopped.busy) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(Date.now() - started < 5000);
    assert.equal(stopped.busy, false);
    assert.equal(stopped.job.status, 'failed');
    assert.equal(stopped.job.error, 'Zastaveno uživatelem.');
    assert.equal(stopped.head, before);
    assert.equal((await post('run/stop', {})).status, 409);
    // The studio is free for the next request.
    assert.equal((await post('run', { prompt: 'Darken the button' })).status, 202);
    for (let i = 0; i < 200 && (await state()).busy; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await state()).job.status, 'ready');
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
