import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { saveNamedDraft, savedDrafts, removeNamedDraft } from '../src/saved-drafts.ts';
import { deleteStepTarget } from '../src/delete-step.ts';
test('HI-04: last-step target is immediate previous step, including unchanged commits and first-step baseline; stale selection rejects', () => {
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40),
    config = {
      requests: [
        { id: 'one', sequence: 1, status: 'ready', commit: a, baseCommit: b },
        { id: 'two', sequence: 2, status: 'ready', commit: a, baseCommit: a },
      ],
    };
  assert.deepEqual(deleteStepTarget(config, 'two', a), { commit: a, id: 'one', sequence: 1, deleteStepId: 'two' });
  assert.equal(deleteStepTarget({ requests: [config.requests[0]] }, 'one', a).commit, b);
  assert.throws(() => deleteStepTarget(config, 'one', a));
  assert.throws(() => deleteStepTarget(config, 'two', b));
});
test('HI-03: save historical step freezes its full tree; removing one named snapshot preserves current work and other snapshot with CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'version-actions-')),
    prior = process.env.SITETILLER_CMS_ROOT;
  process.env.SITETILLER_CMS_ROOT = '';
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({ 'site/fixture.txt': 'Earlier bytes' });
    const earlier = await project.commit('Earlier');
    await project.write({ 'site/fixture.txt': 'Current bytes' });
    const head = await project.commit('Current');
    const a = await saveNamedDraft(project, { name: 'Earlier', expectedHead: head, commit: earlier }),
      b = await saveNamedDraft(project, { name: 'Current', expectedHead: head });
    assert.equal(a.commit, earlier);
    assert.equal(await project.head(), head);
    assert.equal((await project.committedFiles(a.commit))['site/fixture.txt'], 'Earlier bytes');
    const before = await readFile(join(root, 'saved-drafts.json'), 'utf8');
    await assert.rejects(removeNamedDraft(project, { id: a.id, commit: b.commit, expectedHead: head }));
    assert.equal(await readFile(join(root, 'saved-drafts.json'), 'utf8'), before);
    await assert.rejects(removeNamedDraft(project, { id: a.id, commit: a.commit, expectedHead: earlier }));
    await removeNamedDraft(project, { id: a.id, commit: a.commit, expectedHead: head });
    assert.deepEqual(
      (await savedDrafts(project)).map((r) => r.id),
      [b.id],
    );
    assert.equal(await project.git(['rev-parse', b.ref]), b.commit);
    assert.equal(await project.head(), head);
    assert.equal((await project.files())['site/fixture.txt'], 'Current bytes');
    await assert.rejects(project.git(['rev-parse', '--verify', a.ref]));
  } finally {
    if (prior === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = prior;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
