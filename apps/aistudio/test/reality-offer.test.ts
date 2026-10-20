import test from 'node:test';
import assert from 'node:assert/strict';
import { realityOffered } from '../ui/presentation.ts';
const empty = { hasLoadedReality: false, releases: [], hasDraftSteps: false, events: [] };
test('RE-05: a website published by SiteTiller itself is never offered for loading, even without steps', () => {
  // Nothing yet: the offer is shown.
  assert.equal(realityOffered(empty), true);
  // An instance whose version was published by SiteTiller (not an import), with no steps.
  assert.equal(realityOffered({ ...empty, releases: [{ id: 'release-1', number: 1 }] }), false);
  // Version 0 that came from loading the real website still allows the offer while the draft is empty.
  assert.equal(realityOffered({ ...empty, releases: [{ id: 'release-0', number: 0, imported: true }] }), true);
  // Once the real website was loaded or the draft has steps, the offer is gone.
  assert.equal(realityOffered({ ...empty, hasLoadedReality: true }), false);
  assert.equal(
    realityOffered({ ...empty, releases: [{ id: 'release-0', number: 0, imported: true }], hasDraftSteps: true }),
    false,
  );
});
