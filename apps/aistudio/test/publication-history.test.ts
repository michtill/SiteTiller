import test from 'node:test';
import assert from 'node:assert/strict';
import { closePublishedHistory, visibleVersionHistory } from '../src/publication-history.ts';
import { addRequest } from '../src/journal.ts';
import { recentConversation } from '../src/memory.ts';
test('PU-08: published steps are removed while pending work, release snapshots and short agent memory survive', () => {
  const config: any = {
    publishedCommit: 'published',
    releases: [{ id: 'one', number: 1, commit: 'published', publishedAt: '2026-10-06T10:00:00Z' }],
    requests: [
      {
        id: 'a',
        sequence: 1,
        status: 'ready',
        prompt: 'Darken button',
        commit: 'published',
        memory: {
          summary: 'Tlačítko je tmavší.',
          deltas: [{ selector: '.button', property: 'background', before: '#555', after: '#444' }],
        },
        progress: [{ secret: 'trace' }],
        tests: { big: 'test trace' },
      },
      { id: 'b', sequence: 2, status: 'failed', prompt: 'Pending attempt', createdAt: '2026-10-06T10:01:00Z' },
    ],
  };
  const result = closePublishedHistory(config, [
    { jobId: 'a', stage: 'build' },
    { jobId: 'b', stage: 'failed' },
  ]);
  assert.equal(result.removed, 1);
  assert.deepEqual(
    config.requests.map((r: any) => r.id),
    ['b'],
  );
  assert.deepEqual(
    result.events.map((e) => e.jobId),
    ['b'],
  );
  assert.equal(config.releases.length, 1);
  assert.ok(!JSON.stringify(config.conversationMemory).includes('trace'));
  assert.equal(
    recentConversation([...config.conversationMemory, ...config.requests], 'published').turns[0].deltas[0].after,
    '#444',
  );
  assert.equal(addRequest(config, { id: 'c', prompt: 'Ještě trochu' }).sequence, 3);
  const history = ['new', 'draft', 'published', 'old-step', 'older-published'].map((commit) => ({ commit }));
  assert.deepEqual(
    visibleVersionHistory(history, {
      publishedCommit: 'published',
      releases: [{ commit: 'published' }, { commit: 'older-published' }],
    }).map((r) => r.commit),
    ['new', 'draft', 'published', 'older-published'],
  );
});
test('PU-08: without a confirmed publication no work is removed', () => {
  const config: any = { requests: [{ id: 'a', sequence: 1, status: 'ready' }], releases: [] };
  const events = [{ jobId: 'a' }];
  assert.equal(closePublishedHistory(config, events).removed, 0);
  assert.equal(config.requests.length, 1);
});
test('AI-03: a content-only step that stays first after a publication becomes the starting version with its own preview', () => {
  const config: any = {
    publishedCommit: 'published',
    closedThrough: 1,
    releases: [{ id: 'two', number: 2, commit: 'published', publishedAt: '2026-10-19T21:31:52Z' }],
    presentationHead: 'old',
    requests: [
      { id: 'a', sequence: 1, status: 'ready', commit: 'old', presentationChanged: true },
      { id: 'b', sequence: 2, status: 'ready', commit: 'published', presentationChanged: false, changeKind: 'content' },
    ],
  };
  closePublishedHistory(config, []);
  assert.deepEqual(
    config.requests.map((r: any) => [r.id, r.presentationChanged, r.changeKind]),
    [['b', true, 'version']],
  );
  assert.equal(config.presentationHead, 'published');
  assert.equal(config.presentationStepId, 'b');
});
