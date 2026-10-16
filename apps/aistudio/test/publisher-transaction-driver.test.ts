import test from 'node:test';
import assert from 'node:assert/strict';
import { publisherTransaction } from '../src/publisher-transaction.ts';
function fixture() {
  const state: any = { public: false, pushes: 0, finishes: 0, journal: null, fail: null };
  const ops = {
    probeCommitted: async () => state.public,
    prepare: async () => {
      if (state.fail === 'before') throw Error('Prepare failed');
    },
    persist: async (record: any) => {
      if (state.fail === 'confirmed-write' && record.committed) throw Error('Journal locked');
      state.journal = structuredClone(record);
    },
    commit: async () => {
      state.public = true;
      state.pushes++;
      if (state.fail === 'reply-lost') throw Error('Reply lost');
    },
    finish: async () => {
      state.finishes++;
      if (state.fail === 'after') throw Error('Export unavailable');
      return { id: 'release-1', commit: 'published' };
    },
  };
  return { state, ops, record: { commit: 'source', completed: false, committed: false } };
}
test('PU-02: pre-commit preparation failure leaves public state untouched', async () => {
  const f = fixture();
  f.state.fail = 'before';
  await assert.rejects(publisherTransaction(f.record, f.ops), /Prepare failed/);
  assert.equal(f.state.public, false);
  assert.equal(f.state.pushes, 0);
});
test('PU-03: post-commit failure is pending not failed; restart finishes without another push/release', async () => {
  const f = fixture();
  f.state.fail = 'after';
  const first = await publisherTransaction(f.record, f.ops);
  assert.equal(first.state, 'pending');
  assert.equal(first.ok, true);
  assert.equal(f.state.pushes, 1);
  f.state.fail = null;
  const restart = await publisherTransaction(structuredClone(f.state.journal), f.ops);
  assert.equal(restart.state, 'published');
  assert.equal(f.state.pushes, 1);
  await publisherTransaction(structuredClone(f.state.journal), f.ops);
  assert.equal(f.state.pushes, 1);
  assert.equal(f.state.finishes, 2);
});
test('PU-03: lost push reply and failed confirmed journal both probe the committed target on restart', async () => {
  for (const failure of ['reply-lost', 'confirmed-write']) {
    const f = fixture();
    f.state.fail = failure;
    const first = await publisherTransaction(f.record, f.ops);
    assert.equal(first.ok, true);
    f.state.fail = null;
    const second = await publisherTransaction(structuredClone(f.state.journal), f.ops);
    assert.equal(second.state, 'published');
    assert.equal(f.state.pushes, 1);
  }
});
