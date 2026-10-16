import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project.ts';
import { projectManifest } from '../src/manifest.ts';
test('AI-26: Git images larger than 6 MB remain intact and manifest reports real size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-large-media-'));
  try {
    const project = new Project(root);
    await project.init(null);
    await mkdir(join(root, 'site/images'));
    const image = Buffer.alloc(8500000, 123);
    await writeFile(join(root, 'site/images/test.png'), image);
    const commit = await project.commit('Large image');
    assert.deepEqual(await project.binary(commit, 'site/images/test.png'), image);
    const files = await project.files(),
      manifest = await projectManifest(project, files);
    assert.equal(manifest.files.find((f) => f.path === 'site/images/test.png').bytes, image.length);
    await writeFile(join(root, 'site/images/test.png'), Buffer.alloc(20));
    assert.equal(
      (await projectManifest(project, files)).files.find((f) => f.path === 'site/images/test.png').bytes,
      20,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
