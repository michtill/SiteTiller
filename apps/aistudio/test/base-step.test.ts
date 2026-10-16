import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { loadedStepChanges } from '../src/step-changes.ts';
test('HI-09: a version loaded into a draft without steps is its starting version; later loads compare with the draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-base-step-'));
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const before = await project.head();
    await project.write({ 'site/cms/data/items.json': '[{"id":"one"}]' });
    const after = await project.commit('Content only');
    // No previous step: nothing to compare with, the loaded version has its own preview.
    assert.deepEqual(await loadedStepChanges({ requests: [] }, project, before, after), {
      presentationChanged: true,
      changeKind: 'version',
    });
    assert.equal(
      (await loadedStepChanges({ requests: [{ status: 'failed' }] }, project, before, after)).presentationChanged,
      true,
    );
    // With existing steps the load is compared with the draft (here only content differs).
    const later: any = await loadedStepChanges(
      { requests: [{ status: 'ready', commit: before }] },
      project,
      before,
      after,
    );
    assert.equal(later.presentationChanged, false);
    assert.equal(later.changeKind, 'content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
