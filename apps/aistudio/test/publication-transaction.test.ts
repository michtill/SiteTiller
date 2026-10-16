import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import { chromium } from 'playwright';
import { Project } from '../src/project.ts';
import { productionSnapshot } from '../src/production-snapshot.ts';
import { productionReleases, storeProductionRelease } from '../src/production-history.ts';
import { rebaseWorkspace } from '../src/workspace-history.ts';
import { publicationEvidence } from '../src/publication-evidence.ts';
import { initialTeam, initialImages } from '../src/team.ts';
import { websitePolicy } from '../src/site-policy.ts';
import { stopOwnedChild } from '../../../scripts/processes.mjs';
const gateway = 'fixture-gateway-token';
const html = (text: string) =>
  '<!doctype html><html><head><title>' +
  text +
  '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>' +
  text +
  '</h1></body></html>';
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'publication-transaction-')),
    work = new Project(join(data, 'project'));
  await work.init(null);
  await work.write({ 'site/index.html': html('Zero') });
  const seed = await work.commit('Seed'),
    production = new Project(join(data, 'production.git')),
    stage = new Project(join(data, 'stage'));
  await mkdir(production.root);
  await production.git(['init', '--bare', '-b', 'main']);
  await mkdir(stage.root);
  await stage.git(['init', '-b', 'main']);
  const zero = await productionSnapshot(stage, seed, null, work);
  await stage.git(['push', production.root, zero + ':refs/heads/main']);
  await storeProductionRelease(production, { number: 0, description: 'Baseline', previousCommit: null }, zero, seed);
  await rebaseWorkspace(work, production, zero, seed);
  await work.write({ 'site/index.html': html('One') });
  const first = await work.commit('First');
  await work.write({ 'site/index.html': html('Two') });
  const second = await work.commit('Second');
  return { data, work, production, stage, zero, first, second };
}
test(
  'PU-08: Windows live workspace cwd stays valid; retained Git refs preserve original history',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let holder: any;
    try {
      holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: f.work.root,
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((r) => setTimeout(r, 200));
      if (process.platform === 'win32')
        await assert.rejects(rename(f.work.root, join(f.data, 'would-retire')), { code: 'EBUSY' });
      const result = await rebaseWorkspace(f.work, f.production, f.zero, f.first, [f.second]);
      assert.notEqual(result.head, f.second);
      assert.equal((await f.work.files())['site/index.html'], html('Two'));
      assert.equal(await f.work.git(['rev-parse', result.recoveryRef]), f.second);
      await f.work.git(['cat-file', '-e', f.first + '^{commit}']);
      assert.equal(
        (await readdir(f.data)).some((n) => n.startsWith('workspace-retired')),
        false,
      );
    } finally {
      if (holder) await stopOwnedChild(holder);
      await rm(f.data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'PU-02: injected EBUSY before workspace commit retains HEAD, files and recoverable evidence',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const original = f.work.git.bind(f.work);
      let injected = false;
      f.work.git = async (args: string[]) => {
        if (args[0] === 'read-tree' && !injected) {
          injected = true;
          throw Object.assign(Error('Injected EBUSY'), { code: 'EBUSY' });
        }
        return original(args);
      };
      const config = {
          requests: [
            { id: 'one', commit: f.first },
            { id: 'two', commit: f.second },
          ],
        },
        events = [{ jobId: 'one', stage: 'ready' }],
        evidence = await publicationEvidence(f.work, f.data, '0123456789abcdef', config, events);
      await assert.rejects(rebaseWorkspace(f.work, f.production, f.zero, f.first, [f.second]), { code: 'EBUSY' });
      assert.equal(await f.work.head(), f.second);
      assert.equal((await f.work.files())['site/index.html'], html('Two'));
      const saved = JSON.parse(await readFile(join(evidence.directory, 'before.json'), 'utf8'));
      assert.deepEqual(saved.config, config);
      assert.deepEqual(saved.events, events);
      assert.equal(await f.work.git(['rev-parse', evidence.recoveryRef]), f.second);
    } finally {
      await rm(f.data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
