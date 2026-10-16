import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { productionSnapshot } from '../src/production-snapshot.ts';
import { storeProductionRelease } from '../src/production-history.ts';
import { prepareWorkspacePublication } from '../src/workspace-history.ts';
import { finishConfirmedPublication } from '../src/publication-finish.ts';
import { confirmedPublicationEvidence, restoreConfirmedPublicationEvidence } from '../src/publication-evidence.ts';
const html = (s: string) =>
  '<!doctype html><html><head><title>' +
  s +
  '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>' +
  s +
  '</main></body></html>';
async function fixture(run: any) {
  const data = await mkdtemp(join(tmpdir(), 'internal-publication-')),
    old = process.env.SITETILLER_PRODUCTION_HISTORY_DIR;
  try {
    const work = new Project(join(data, 'project'));
    await work.init(null);
    await work.write({ 'site/index.html': html('One') });
    const selected = await work.commit('Selected');
    await work.write({ 'site/index.html': html('Newer') });
    await mkdir(join(work.root, 'site/assets'), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 3]);
    await writeFile(join(work.root, 'site/assets/new.pdf'), bytes);
    await writeFile(join(work.root, 'site/assets/new.docx'), bytes);
    const newer = await work.commit('Newer with binaries');
    await writeFile(join(work.root, 'project-manifest.json'), 'HOST CACHE');
    await work.git(['update-ref', 'refs/sitetiller/saved-drafts/fixture', newer]);
    await writeFile(join(data, 'saved-drafts.json'), '[{"fixture":"preserve"}]');
    const production = new Project(join(data, 'production.git')),
      stage = new Project(join(data, 'stage'));
    await mkdir(production.root);
    await production.git(['init', '--bare', '-b', 'main']);
    await mkdir(stage.root);
    await stage.git(['init', '-b', 'main']);
    const exported = await productionSnapshot(stage, selected, null, work);
    await stage.git(['push', production.root, exported + ':refs/heads/main']);
    const release = await storeProductionRelease(
      production,
      { number: 1, description: 'Fixture', previousCommit: null },
      exported,
      selected,
    );
    process.env.SITETILLER_PRODUCTION_HISTORY_DIR = production.root;
    const config: any = {
      providers: { private: 'unchanged' },
      requests: [
        { id: 'one', sequence: 1, status: 'ready', commit: selected },
        { id: 'newer', sequence: 2, status: 'ready', commit: newer },
      ],
      releases: [],
      pendingRelease: {
        commit: selected,
        through: 1,
        number: 1,
        confirmedRelease: release,
        evidence: { directory: join(data, 'evidence') },
      },
      publishedCommit: null,
    };
    await confirmedPublicationEvidence(data, config.pendingRelease);
    await run({ data, work, production, selected, newer, release, config, bytes });
  } finally {
    if (old === undefined) delete process.env.SITETILLER_PRODUCTION_HISTORY_DIR;
    else process.env.SITETILLER_PRODUCTION_HISTORY_DIR = old;
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
test('PU-08: pre-public preparation is readonly, ignores host cache but rejects real dirty site; all newer binary bytes and saved refs survive finish', () =>
  fixture(async (f) => {
    const plan = await prepareWorkspacePublication(f.work, f.selected);
    assert.equal(plan.head, f.newer);
    assert.equal(await f.work.head(), f.newer);
    await f.work.write({ 'site/index.html': html('Unsaved') });
    await assert.rejects(prepareWorkspacePublication(f.work, f.selected), /neuložené změny webu/);
    await f.work.write({ 'site/index.html': html('Newer') });
    const result = await finishConfirmedPublication(f.work, f.data, f.config, [], {});
    assert.equal(result.completed, true);
    // The published step stays as the first step of the draft.
    assert.deepEqual(
      result.config.requests.map((r: any) => r.id),
      ['one', 'newer'],
    );
    for (const name of ['new.pdf', 'new.docx'])
      assert.deepEqual(await f.work.binary(await f.work.head(), 'site/assets/' + name), f.bytes);
    assert.equal(await readFile(join(f.work.root, 'project-manifest.json'), 'utf8'), 'HOST CACHE');
    assert.equal(await f.work.git(['rev-parse', 'refs/sitetiller/saved-drafts/fixture']), f.newer);
    assert.equal(await f.production.head(), f.release.commit);
  }));
test('PU-03: crash after workspace HEAD update before pending metadata reuses durable install plan without replaying published changes', () =>
  fixture(async (f) => {
    const git = Project.prototype.git;
    let fault = true;
    Project.prototype.git = async function (args: string[]) {
      const value = await git.call(this, args);
      if (this.root === f.work.root && args[0] === 'update-ref' && args[1] === 'HEAD' && fault) {
        fault = false;
        throw Error('Injected crash after HEAD');
      }
      return value;
    };
    try {
      await assert.rejects(finishConfirmedPublication(f.work, f.data, f.config, [], {}), /Injected crash/);
    } finally {
      Project.prototype.git = git;
    }
    const head = await f.work.head();
    assert.notEqual(head, f.newer);
    const result = await finishConfirmedPublication(f.work, f.data, f.config, [], {});
    assert.equal(await f.work.head(), head);
    // The published step stays as the first step of the draft.
    assert.deepEqual(
      result.config.requests.map((r: any) => r.id),
      ['one', 'newer'],
    );
    assert.equal(await f.production.head(), f.release.commit);
  }));
test('PU-03: events/config/job crash boundaries restart internally even when pending config is already null; newer work is retained', () =>
  fixture(async (f) => {
    const rename = fs.promises.rename;
    let fail = 'config.json';
    fs.promises.rename = async function (from: any, to: any) {
      if (String(to) === join(f.data, fail)) {
        fail = '';
        throw Error('Injected metadata crash');
      }
      return rename.call(this, from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(finishConfirmedPublication(f.work, f.data, f.config, [], {}), /metadata crash/);
    } finally {
      fs.promises.rename = rename;
      syncBuiltinESMExports();
    }
    const config = structuredClone(f.config);
    await restoreConfirmedPublicationEvidence(f.data, config);
    const first = await finishConfirmedPublication(f.work, f.data, config, [], {});
    assert.equal(first.config.pendingRelease, null);
    await confirmedPublicationEvidence(f.data, {
      ...f.config.pendingRelease,
      rebuilt: JSON.parse(await readFile(join(f.data, 'evidence/finish.json'), 'utf8')).rebuilt,
    });
    await f.work.write({ 'site/index.html': html('Later after process crash') });
    const later = await f.work.commit('Later');
    first.config.requests.push({ id: 'later', sequence: 3, status: 'ready', commit: later });
    await restoreConfirmedPublicationEvidence(f.data, first.config);
    const final = await finishConfirmedPublication(f.work, f.data, first.config, [], {});
    assert.equal(await f.work.head(), later);
    assert.deepEqual(
      final.config.requests.map((r) => r.id),
      ['one', 'newer', 'later'],
    );
    assert.equal(await f.production.head(), f.release.commit);
  }));
for (const boundary of ['events.json', 'last-job.json'])
  test('PU-03: restart at ' + boundary + ' metadata boundary preserves newer draft and confirmed release', () =>
    fixture(async (f) => {
      const rename = fs.promises.rename;
      let armed = true;
      fs.promises.rename = async function (from: any, to: any) {
        if (armed && String(to) === join(f.data, boundary)) {
          armed = false;
          throw Error('Injected boundary crash');
        }
        return rename.call(this, from, to);
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(finishConfirmedPublication(f.work, f.data, f.config, [], {}), /boundary crash/);
      } finally {
        fs.promises.rename = rename;
        syncBuiltinESMExports();
      }
      let config: any;
      try {
        config = JSON.parse(await readFile(join(f.data, 'config.json'), 'utf8'));
      } catch {
        config = structuredClone(f.config);
      }
      await restoreConfirmedPublicationEvidence(f.data, config);
      const head = await f.work.head(),
        result = await finishConfirmedPublication(f.work, f.data, config, [], {});
      assert.equal(result.completed, true);
      assert.equal(await f.work.head(), head);
      assert.deepEqual(
        result.config.requests.map((r) => r.id),
        ['one', 'newer'],
      );
      assert.equal(await f.production.head(), f.release.commit);
      assert.equal(await readFile(join(f.work.root, 'project-manifest.json'), 'utf8'), 'HOST CACHE');
    }),
  );
