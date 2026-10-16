import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
test('HI-10: saved-draft refs resolve from loose and packed ref files like git rev-parse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-ref-'));
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const head = await project.head(),
      ref = 'refs/sitetiller/saved-drafts/' + 'a'.repeat(32);
    assert.equal(await project.resolveRef(ref), '');
    await project.git(['update-ref', ref, head]);
    assert.equal(await project.resolveRef(ref), head);
    await project.git(['pack-refs', '--all']);
    assert.equal(await project.resolveRef(ref), await project.git(['rev-parse', ref]));
    await project.git(['update-ref', '-d', ref]);
    assert.equal(await project.resolveRef(ref), '');
    await assert.rejects(project.resolveRef('refs/../config'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
