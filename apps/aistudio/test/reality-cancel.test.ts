import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserChecks } from '../src/checks.ts';
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
