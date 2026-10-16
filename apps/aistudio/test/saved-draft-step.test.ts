import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { remapSavedDraftSteps, savedDraftStep } from '../src/saved-drafts.ts';
test('HI-10: saved drafts follow their step when the draft history is rebuilt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-saved-step-'));
  try {
    await mkdir(join(root, 'project'));
    const project = new Project(join(root, 'project')),
      commit = (c: string) => c.repeat(40),
      record = (id: string, presentationHead: string) => ({
        id: 'draft-' + id.repeat(32),
        ref: 'refs/sitetiller/saved-drafts/' + id.repeat(32),
        name: id,
        commit: commit('f'),
        presentationHead,
      });
    const path = join(root, 'saved-drafts.json');
    await writeFile(path, JSON.stringify([record('a', commit('1')), record('b', commit('2'))]));
    const mapping = { [commit('2')]: commit('9') };
    await remapSavedDraftSteps(project, mapping);
    const once = JSON.parse(await readFile(path, 'utf8'));
    // The published step now has the release commit; a closed step keeps its old commit and so has no badge.
    assert.deepEqual(once.map(savedDraftStep), [commit('1'), commit('9')]);
    assert.equal(once[1].presentationHead, commit('2'));
    // Replaying the same rebuild changes nothing.
    await remapSavedDraftSteps(project, mapping);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
