import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
// The instance status for a waker (documentation 2.6).
test('OP-10: the instance status answers only with its token; user requests move the last activity, status calls do not', { timeout: 120000 }, async () => {
  const stack = await isolatedStack();
  try {
    const token = (await readFile(join(stack.root, 'settings/status.token'), 'utf8')).trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    const status = (value, host) =>
      fetch(stack.origin + '/__sitetiller/status', {
        headers: { ...(value ? { Authorization: 'Bearer ' + value } : {}), ...(host ? { Host: host } : {}) },
      });
    // Without the right token the address does not exist.
    for (const value of ['', 'x'.repeat(64), token.slice(1)]) assert.equal((await status(value)).status, 404, value);
    const first = await (await status(token)).json();
    assert.deepEqual(Object.keys(first).sort(), ['busy', 'lastActivity']);
    assert.equal(first.busy, false);
    await new Promise((r) => setTimeout(r, 20));
    // A status call is not activity.
    assert.equal((await (await status(token)).json()).lastActivity, first.lastActivity);
    // A user's request is.
    await fetch(stack.origin + '/login');
    const after = await (await status(token)).json();
    assert.ok(after.lastActivity > first.lastActivity);
  } finally {
    await stack.close();
  }
});
