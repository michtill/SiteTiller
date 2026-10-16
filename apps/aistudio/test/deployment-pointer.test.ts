import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploySite } from '../deploy/site-release.mjs';
import { localProductionState } from '../src/local-production.ts';
test('PU-09: publication updates the JSON pointer consumed by the website on Windows and Linux and preserves previous release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publication-pointer-'));
  try {
    const first = 'a'.repeat(40),
      second = 'b'.repeat(40);
    const project = {
      committedFiles: async (commit: string) => ({ 'site/index.html': 'Version ' + commit }),
      binary: async () => Buffer.alloc(0),
    };
    const old = await deploySite(project, first, root);
    const active = await deploySite(project, second, root);
    const state = await localProductionState(root);
    assert.equal(state.commit, second);
    assert.equal(state.directory, active);
    assert.equal(await readFile(join(state.directory, 'index.html'), 'utf8'), 'Version ' + second);
    assert.equal(await readFile(join(old, 'index.html'), 'utf8'), 'Version ' + first);
    if (process.platform !== 'win32') assert.equal(await readlink(join(root, 'current')), 'releases/' + second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
