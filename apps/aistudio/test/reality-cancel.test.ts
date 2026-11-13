import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserChecks, launchBrowser } from '../src/checks.ts';
import { runWithStop } from '../src/run-control.ts';
test('RE-04: a stop or a spent time budget ends the browser check of a loaded website at once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-reality-cancel-'));
  try {
    // A page that never finishes loading: its script never returns.
    const files = {
      'site/index.html':
        '<!doctype html><html><head><title>Busy</title></head><body><h1>Busy</h1><script>for(;;){}</script></body></html>',
    };
    const started = Date.now();
    const outcome = await runWithStop(AbortSignal.timeout(1500), () => browserChecks(root, files)).then(
      (result: any) => ({ passed: result.passed }),
      (error: any) => ({ error: error.message }),
    );
    // Without the stop the page waits for its 15 s navigation limit per page and viewport.
    assert.ok(Date.now() - started < 10000, 'took ' + (Date.now() - started) + ' ms');
    assert.notDeepEqual(outcome, { passed: true });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
test('AI-10: a stop while the browser is still starting ends the check at once (a browser starting in a full container never returned)', async () => {
  let closed = false;
  const starting = new Promise((resolve) =>
    setTimeout(() => resolve({ close: async () => void (closed = true) }), 3000),
  );
  const chromium = { launch: () => starting };
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 200);
  await assert.rejects(
    runWithStop(stop.signal, () => launchBrowser(chromium)),
    (e: any) => e.stopped === true,
  );
  assert.ok(Date.now() - started < 1500, 'took ' + (Date.now() - started) + ' ms');
  // The browser that starts later is closed, not left running.
  await starting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});
test('RE-04: a spent time budget of the browser check is a failed check with its reason, not a wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-check-budget-'));
  const before = process.env.SITETILLER_BROWSER_CHECK_BUDGET;
  process.env.SITETILLER_BROWSER_CHECK_BUDGET = '1500';
  try {
    const files = {
      'site/index.html':
        '<!doctype html><html><head><title>Busy</title></head><body><h1>Busy</h1><script>for(;;){}</script></body></html>',
    };
    const started = Date.now();
    const result: any = await browserChecks(root, files);
    assert.ok(Date.now() - started < 10000, 'took ' + (Date.now() - started) + ' ms');
    assert.equal(result.passed, false);
    assert.match(result.errors.join(' '), /nedoběhla do 2 s/);
  } finally {
    if (before === undefined) delete process.env.SITETILLER_BROWSER_CHECK_BUDGET;
    else process.env.SITETILLER_BROWSER_CHECK_BUDGET = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
