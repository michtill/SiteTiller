import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/project.ts';
import { productionSnapshot } from '../src/production-snapshot.ts';
import { storeProductionRelease, productionReleases } from '../src/production-history.ts';
import { initialTeam, initialImages } from '../src/team.ts';
import { websitePolicy } from '../src/site-policy.ts';
import { stopOwnedChild } from '../../../scripts/processes.mjs';
const html = (s) =>
  '<!doctype html><html><head><title>' +
  s +
  '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>' +
  s +
  '</main></body></html>';
async function port() {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const value = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return value;
}
test('PU-03: real publisher202/controller HTTP/restart finishes once internally, preserves newer draft and never republishes', async () => {
  const data = await mkdtemp(join(tmpdir(), 'publication-http-')),
    children: any[] = [];
  let live: any;
  try {
    const work = new Project(join(data, 'project'));
    await work.init(null);
    await work.write({ 'site/index.html': html('Zero') });
    const seed = await work.commit('Zero'),
      production = new Project(join(data, 'production.git')),
      stage = new Project(join(data, 'stage'));
    await mkdir(production.root);
    await production.git(['init', '--bare', '-b', 'main']);
    await mkdir(stage.root);
    await stage.git(['init', '-b', 'main']);
    const zero = await productionSnapshot(stage, seed, null, work);
    await stage.git(['push', production.root, zero + ':refs/heads/main']);
    await storeProductionRelease(production, { number: 0, description: 'Zero', previousCommit: null }, zero, seed);
    await work.write({ 'site/index.html': html('One') });
    const selected = await work.commit('One');
    await work.write({ 'site/index.html': html('Two') });
    const newer = await work.commit('Two');
    await work.git(['update-ref', 'refs/sitetiller/saved-drafts/fixture', newer]);
    await writeFile(join(work.root, 'project-manifest.json'), 'CACHE');
    await mkdir(join(data, 'public'));
    await writeFile(join(data, 'hold-export'), 'fixture');
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        automaticReasoningPolicy: 1,
        slots: [],
        requests: [
          { id: 'one', sequence: 1, status: 'ready', commit: selected },
          { id: 'two', sequence: 2, status: 'ready', commit: newer },
        ],
        publishedCommit: zero,
        publishedThrough: 0,
        separatedHistories: true,
      }),
    );
    live = createServer(async (req, res) => {
      res.setHeader('Content-Security-Policy', websitePolicy);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      try {
        const p = JSON.parse(await readFile(join(data, 'public/current.json'), 'utf8'));
        res.end(await readFile(join(p.directory, 'index.html')));
      } catch {
        res.end(html('Zero'));
      }
    });
    await new Promise<void>((r) => live.listen(0, '127.0.0.1', r));
    const pubPort = await port(),
      aiPort = await port(),
      origin = 'http://127.0.0.1:' + aiPort,
      pub = 'http://127.0.0.1:' + pubPort,
      secret = 'fixture-gateway',
      env = {
        ...process.env,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        SITETILLER_DATA_DIR: data,
        SITETILLER_PRODUCTION_GIT: production.root,
        SITETILLER_PRODUCTION_HISTORY_DIR: production.root,
        SITETILLER_PRODUCTION_DIRECTORY: join(data, 'public'),
        SITETILLER_PRODUCTION_URL: 'http://127.0.0.1:' + live.address().port + '/',
        SITETILLER_PUBLISH_TOKEN: 'fixture-publish',
        SITETILLER_GATEWAY_TOKEN: secret,
        SITETILLER_PUBLISH_URL: pub + '/publish',
        SITETILLER_CMS_ROOT: '',
        SITETILLER_FAULT_DATA_DIR: data,
        SITETILLER_ORIGIN: origin,
        SITETILLER_OFFLINE: '1',
        HOST: '127.0.0.1',
      };
    const start = async (name: string, p: number) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          new URL('./fixtures/publisher-export-fault.ts', import.meta.url).href,
          fileURLToPath(new URL('../src/' + name + '.ts', import.meta.url)),
        ],
        { windowsHide: true, env: { ...env, PORT: String(p) }, stdio: 'ignore' },
      );
      children.push(child);
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(
            (name === 'publisher' ? pub : origin) + (name === 'publisher' ? '/status' : '/health'),
            { headers: { Authorization: 'Bearer fixture-publish' } },
          );
          if (r.ok) return child;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error('Fixture unavailable');
    };
    await start('publisher', pubPort);
    let controller = await start('server', aiPort);
    const post = async (path: string, body: any) => {
      const r = await fetch(origin + '/api/' + path, {
        method: 'POST',
        headers: { 'x-sitetiller-gateway': secret, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, value: await r.json() };
    };
    const get = async () =>
      await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': secret } })).json();
    const result = await post('publish', {
      commit: selected,
      expectedHead: newer,
      stepId: 'one',
      confirmCmsPublication: true,
    });
    assert.equal(result.status, 202, JSON.stringify(result));
    assert.equal(result.value.publishing, true);
    assert.notEqual(await production.head(), zero);
    assert.equal(await work.head(), newer);
    assert.equal((await get()).job.status, 'running');
    assert.equal((await post('publish', { commit: newer, expectedHead: newer })).status, 409);
    await stopOwnedChild(controller);
    await rm(join(data, 'hold-export'));
    controller = await start('server', aiPort);
    let state;
    for (let i = 0; i < 120; i++) {
      state = await get();
      if (!state.busy && !state.publicationInProgress) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(state.busy, false);
    // The published step stays as the first step; the newer one follows.
    assert.deepEqual(
      state.requests.map((r: any) => r.id),
      ['one', 'two'],
    );
    assert.equal((await work.files())['site/index.html'], html('Two'));
    assert.equal((await productionReleases(production)).length, 2);
    assert.equal(await production.git(['rev-list', '--count', 'HEAD']), '2');
    assert.equal(await work.git(['rev-parse', 'refs/sitetiller/saved-drafts/fixture']), newer);
    assert.equal(await readFile(join(work.root, 'project-manifest.json'), 'utf8'), 'CACHE');
    assert.equal((await post('publication/recover', {})).status, 404);
    {
      const page = await (await fetch(origin + '/')).text(),
        script = page.match(/assets\/[\w.-]+\.js/)?.[0];
      assert.ok(script);
      assert.ok(
        !page.includes('recover-publication') &&
          !(await (await fetch(origin + '/' + script)).text()).includes('recover-publication'),
      );
    }
  } finally {
    for (const child of children) await stopOwnedChild(child);
    if (live) await new Promise<void>((r) => live.close(() => r()));
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
