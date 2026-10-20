import test from 'node:test';
import assert from 'node:assert/strict';
import { closePublishedHistory, publicationClosing, unpublishedRequests } from '../src/publication-history.ts';
import { deleteStepTarget } from '../src/delete-step.ts';
const A = 'a'.repeat(40),
  B = 'b'.repeat(40),
  C = 'c'.repeat(40);
const draft = () => ({
  publishedCommit: B,
  publishedThrough: 0,
  releases: [{ id: 'release-1', number: 1, commit: B, publishedAt: '2026-10-05T12:00:00Z' }],
  requests: [
    { id: 'a', sequence: 1, status: 'ready', commit: A, prompt: 'A', createdAt: '2026-10-05T11:00:00Z' },
    { id: 'b', sequence: 2, status: 'ready', commit: B, prompt: 'B', createdAt: '2026-10-05T11:10:00Z' },
    { id: 'c', sequence: 3, status: 'ready', commit: C, prompt: 'C', createdAt: '2026-10-05T11:20:00Z' },
  ],
});
const events = [
  { jobId: 'a', stage: 'ready', commit: A },
  { jobId: 'b', stage: 'ready', commit: B },
  { jobId: 'c', stage: 'ready', commit: C },
];
const shown = (config: any) => config.requests.map((r: any) => (r.firstStep ? 'first:' + r.firstStep : r.id));
const publish = (config: any, clearPrevious: boolean) => {
  publicationClosing(config, B, 2, clearPrevious);
  config.publishedThrough = 2;
  return closePublishedHistory(config, events).events;
};
test('PU-08: publishing with "remove previous steps" replaces the steps through the published one by a new first step', () => {
  const config: any = draft(),
    kept = publish(config, true);
  // A new first step "Published version 1" with the published state and its own preview; later steps stay.
  assert.deepEqual(shown(config), ['first:published', 'c']);
  const first = config.requests[0];
  assert.deepEqual(
    [first.commit, first.releaseId, first.releaseVersion, first.presentationChanged, first.prompt, first.finalAnswer],
    [B, 'release-1', '1', true, '', undefined],
  );
  assert.notEqual(first.id, 'b');
  assert.deepEqual(
    kept.map((e: any) => e.jobId),
    ['c'],
  );
  // The removed steps are discarded: the AI does not remember them.
  assert.deepEqual(config.conversationMemory, []);
  // Only the steps after the publication are unpublished work.
  assert.deepEqual(
    unpublishedRequests(config).map((r: any) => r.id),
    ['c'],
  );
  // A restart closes nothing more.
  closePublishedHistory(config, kept);
  assert.deepEqual(shown(config), ['first:published', 'c']);
  assert.deepEqual(config.conversationMemory, []);
});
test('PU-08: publishing without "remove previous steps" leaves the draft steps unchanged, also after a restart', () => {
  const config: any = draft(),
    kept = publish(config, false);
  assert.deepEqual(
    config.requests.map((r: any) => r.id),
    ['a', 'b', 'c'],
  );
  assert.equal(kept.length, 3);
  closePublishedHistory(config, kept);
  assert.deepEqual(
    config.requests.map((r: any) => r.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    unpublishedRequests(config).map((r: any) => r.id),
    ['c'],
  );
  // A later publication with the option closes everything before its step.
  config.requests.push({ id: 'd', sequence: 4, status: 'ready', commit: 'd'.repeat(40), prompt: 'D' });
  publicationClosing(config, C, 3, true);
  config.publishedThrough = 3;
  closePublishedHistory(config, kept);
  assert.deepEqual(shown(config), ['first:published', 'd']);
});
test('PU-08: the published step that opens the draft cannot be deleted; a later step can', () => {
  const config: any = draft();
  config.requests = config.requests.slice(0, 2);
  publish(config, true);
  const first = config.requests[0].id;
  assert.throws(() => deleteStepTarget(config, first, B), /Publikovaný krok nelze odstranit/);
  config.requests.push({ id: 'c', sequence: 3, status: 'ready', commit: C, baseCommit: B });
  assert.deepEqual(deleteStepTarget(config, 'c', C), { commit: B, id: first, sequence: 2, deleteStepId: 'c' });
});
