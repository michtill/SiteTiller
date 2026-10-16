import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const gateway = 'fixture-gateway-token';
test('AI-25: server retains failed communication across restart and never includes it in browser responses', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-diagnostic-api-')),
    port = 22100 + Math.floor(Math.random() * 100),
    origin = 'http://127.0.0.1:' + port;
  let child: any,
    cookie = '';
  const post = (path: string, body: any) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: origin, 'x-sitetiller-gateway': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const state = async () =>
    (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookie } })).json()) as any;
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/provider-server.mjs', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        SITETILLER_DATA_DIR: data,
        HOST: '127.0.0.1',
        PORT: String(port),
        SITETILLER_ORIGIN: origin,
        OPENAI_API_KEY: 'fixture-private-key',
        ANTHROPIC_API_KEY: 'fixture-anthropic',
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    cookie = gateway;
  };
  const stop = async () => {
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      child = null;
    }
  };
  const wait = async () => {
    for (let i = 0; i < 200; i++) {
      const value = await state();
      if (!value.busy) return value;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Job timeout');
  };
  try {
    await start();
    assert.equal((await post('run', { prompt: 'Fixture provider failure' })).status, 202);
    const failed = await wait();
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.error, /HTTP 429/);
    const id = failed.job.id,
      path = join(data, 'diagnostics', id + '.jsonl'),
      text = await readFile(path, 'utf8');
    assert.match(text, /provider_request/);
    assert.match(text, /rate_limit_error/);
    assert.match(text, /job_error/);
    assert.ok(!text.includes('fixture-private-key'));
    assert.ok(!JSON.stringify(failed).includes('rate_limit_error'));
    assert.ok(!JSON.stringify(failed).includes('Act as WEB LEAD'));
    assert.equal((await fetch(origin + '/diagnostics/' + id + '.jsonl')).status, 404);
    await stop();
    await start();
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal((await post('run', { prompt: 'Co znamená tato chyba?' })).status, 202);
    const succeeded = await wait();
    assert.equal(succeeded.job.status, 'ready');
    // Completed jobs keep their transcript too (the newest 30 stay); the failed one is unchanged.
    assert.deepEqual(
      (await readdir(join(data, 'diagnostics'))).sort(),
      [id + '.jsonl', succeeded.job.id + '.jsonl'].sort(),
    );
    assert.equal(await readFile(path, 'utf8'), text);
  } finally {
    await stop();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
