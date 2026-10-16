import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { checkPublication, restorationSource } from '../src/publication-check.ts';
const passed = async () => ({ passed: true, errors: [] }) as any;
test('PU-10: a draft continued from a saved draft is checked against the draft repository, a release against production', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-restoration-'));
  try {
    const project = new Project(join(root, 'project')),
      production = new Project(join(root, 'production'));
    await project.init(null);
    await production.init(null);
    await production.write({
      'site/index.html': '<!doctype html><html><head><title>P</title></head><body>P</body></html>',
    });
    const release = await production.commit('Release');
    const saved = await project.head();
    const config = { separatedHistories: true, releases: [{ commit: release }] };
    assert.equal(restorationSource(config, saved, production, project), project);
    assert.equal(restorationSource(config, release, production, project), production);
    assert.equal(restorationSource({ ...config, separatedHistories: false }, release, production, project), project);
    assert.equal(restorationSource(config, undefined, production, project), project);
    // The saved-draft case that failed with "path 'site' does not exist" when production was asked.
    const result = await checkPublication(
      project,
      saved,
      saved,
      passed,
      saved,
      restorationSource(config, saved, production, project),
    );
    assert.equal(result.restoration.identical, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
