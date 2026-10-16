import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { readJson } from '../packages/settings/index.mjs';
test('HI-04: actual last-step deletion restores exactly immediate predecessor and first-step baseline with content CAS; never discards publication', async () => {
  const stack = await isolatedStack({ controllerImports: ['apps/aistudio/test/fixtures/version-actions-seed.ts'] });
  try {
    const targets = await readJson(join(stack.root, '.sitetiller/action-fixture.json')),
      login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      cookie = login.headers.get('set-cookie').split(';')[0],
      headers = { Cookie: cookie, Origin: stack.origin, 'Content-Type': 'application/json' },
      pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8');
    const post = async (path, body) => {
        const reply = await fetch(stack.origin + '/site/api/' + path, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        return { status: reply.status, value: await reply.json() };
      },
      state = async () => await (await fetch(stack.origin + '/site/api/state', { headers })).json();
    assert.equal(
      (
        await post('restore/prepare', {
          commit: targets.first,
          expectedHead: targets.base,
          deleteStepId: 'fixture-last',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post('restore', {
          commit: targets.first,
          expectedHead: targets.last,
          deleteStepId: 'fixture-last',
          historyMode: 'keep',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post('restore/prepare', {
          commit: targets.first,
          expectedHead: targets.last,
          deleteStepId: 'fixture-first',
        })
      ).status,
      400,
    );
    assert.equal((await state()).head, targets.last);
    let prepared = await post('restore/prepare', {
      commit: targets.first,
      expectedHead: targets.last,
      deleteStepId: 'fixture-last',
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.value.hasContent, true);
    let result = await post('restore', {
      commit: targets.first,
      expectedHead: targets.last,
      deleteStepId: 'fixture-last',
      stepId: 'fixture-first',
      historyMode: 'rewind',
      confirmContentRestore: true,
      contentRevision: prepared.value.revision,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    let current = await state();
    assert.equal(current.head, targets.first);
    assert.deepEqual(
      current.requests.map((r) => r.id),
      ['fixture-first'],
    );
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
    prepared = await post('restore/prepare', {
      commit: targets.base,
      expectedHead: targets.first,
      deleteStepId: 'fixture-first',
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    result = await post('restore', {
      commit: targets.base,
      expectedHead: targets.first,
      deleteStepId: 'fixture-first',
      historyMode: 'rewind',
      confirmContentRestore: true,
      contentRevision: prepared.value.revision,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    current = await state();
    assert.equal(current.head, targets.base);
    assert.equal(current.requests.length, 0);
    assert.equal((await readJson(join(stack.root, '.sitetiller/config.json'))).requestSequence, 2);
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
  } finally {
    await stack.close();
  }
});
