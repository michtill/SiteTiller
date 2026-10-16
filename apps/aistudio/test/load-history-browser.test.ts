import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { storeProductionRelease } from '../src/production-history.ts';
import { Project } from '../src/project.ts';
import { initialTeam, initialImages } from '../src/team.ts';
const gateway = 'fixture-gateway-token';
test('HI-05: returning to a step deletes only later edits; loading a published version can clear the whole draft', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-load-history-'));
  let child: any, browser: any;
  try {
    const project = new Project(join(data, 'project'));
    await project.init(null);
    const html = (name: string) =>
      '<!doctype html><html><head><title>' +
      name +
      '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>' +
      name +
      '</h1></body></html>';
    await project.write({ 'site/index.html': html('Published') });
    const published = await project.commit('Published');
    await project.write({ 'site/index.html': html('Step one') });
    const first = await project.commit('Step one');
    await project.write({ 'site/index.html': html('Step two') });
    const head = await project.commit('Step two');
    const remote = join(data, 'production.git');
    await mkdir(remote);
    const production = new Project(remote);
    await production.git(['init', '--bare', '-b', 'main']);
    await project.git(['push', remote, published + ':refs/heads/main']);
    const release = await storeProductionRelease(
        production,
        { number: 8, description: 'Published', previousCommit: null },
        published,
        published,
      ),
      password = 'test-password-sitetiller',
      salt = 'salt';
    await writeFile(
      join(data, 'events.json'),
      JSON.stringify([
        {
          jobId: 'publication-8',
          kind: 'publish',
          stage: 'published',
          commit: published,
          release,
          // The event follows the confirmed release.
          at: new Date(Date.parse(release.publishedAt) + 1000).toISOString(),
        },
      ]),
    );
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        password: { salt, hash: scryptSync(password, salt, 64).toString('hex') },
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        automaticReasoningPolicy: 1,
        separatedHistories: true,
        historyInitialized: true,
        publishedCommit: published,
        publishedThrough: 0,
        releases: [release],
        requests: [
          { id: 'one', prompt: 'First edit', commit: first, status: 'ready', sequence: 1 },
          { id: 'two', prompt: 'Second edit', commit: head, status: 'ready', sequence: 2 },
          { id: 'failed', prompt: 'Failed attempt', status: 'failed', sequence: 3 },
        ],
      }),
    );
    const port = 20400 + Math.floor(Math.random() * 150),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/provider-server.mjs', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        SITETILLER_UI_LANGUAGE: 'cs',
        SITETILLER_DATA_DIR: data,
        SITETILLER_PRODUCTION_HISTORY_DIR: remote,
        HOST: '127.0.0.1',
        PORT: String(port),
        SITETILLER_ORIGIN: origin,
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const cookie = gateway;
    const state = async () =>
      (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookie } })).json()) as any;
    const post = (input: any) =>
      fetch(origin + '/api/restore', {
        method: 'POST',
        headers: { Origin: origin, 'x-sitetiller-gateway': cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    assert.equal(
      (await post({ commit: first, expectedHead: head, historyMode: 'clear-all', stepId: 'missing' })).status,
      409,
    );
    assert.equal(await project.head(), head);
    assert.equal((await post({ commit: published, expectedHead: head, historyMode: 'rewind' })).status, 409);
    await writeFile(join(project.root, 'project-manifest.json'), JSON.stringify({ version: 1, cache: true }));
    await writeFile(join(project.root, 'site', 'unsaved.txt'), 'Unsaved website content');
    const blocked = await post({ commit: first, expectedHead: head, historyMode: 'rewind', stepId: 'one' });
    assert.equal(blocked.status, 400);
    assert.ok((await blocked.json()).error.includes('neuložené změny'));
    assert.equal(await project.head(), head);
    await rm(join(project.root, 'site', 'unsaved.txt'));
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    await page.context().setExtraHTTPHeaders({ 'x-sitetiller-gateway': cookie });
    await page.goto(origin);
    // The publication that opens the draft names its version; the edits after it have no badge.
    await page.locator('#timeline .step-badge').first().waitFor();
    assert.deepEqual(await page.locator('#timeline .step-badge').allTextContents(), ['Publikováno: Verze 8']);
    await page.locator('#timeline .show-version[data-commit="' + first + '"]').click();
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-preview').textContent(), 'Vrátit se sem');
    assert.equal(await page.locator('#restore-clear-label').textContent(), 'Odstranit následující úpravy');
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    assert.ok(!(await page.locator('#restore-confirm').textContent())?.includes('commit'));
    await page.locator('#restore-clear-previous').uncheck();
    await page.locator('#cancel-restore').click();
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    await page.locator('#restore-clear-previous').check();
    await page.locator('#cancel-restore').click();
    assert.equal(await project.head(), head);
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    await page.locator('#restore-clear-previous').check();
    await page.locator('#confirm-restore').click();
    await page.locator('#restore-confirm').waitFor({ state: 'hidden' });
    const rewound = await state();
    assert.equal(rewound.head, first);
    assert.equal(await project.git(['rev-parse', 'HEAD^']), published);
    assert.equal(rewound.requests.length, 1);
    assert.equal(rewound.requests[0].id, 'one');
    assert.equal(rewound.job, null);
    assert.equal(rewound.releases[0].commit, release.commit);
    assert.equal((await fetch(origin + '/preview/versions/' + head + '/')).status, 404);
    assert.equal(await project.git(['log', '-1', '--format=%s']), 'Step one');
    assert.equal(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')).requestSequence, 3);
    await rm(join(project.root, 'project-manifest.json')); // The next clear-all operation requires a clean workspace, including untracked fixture cache.

    await page.locator('#history-toggle').click();
    await page.locator('#history .publication-card').click();
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    await page.locator('#cancel-restore').click();
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-clear-label').textContent(), 'Odstranit všechny rozpracované úpravy');
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    await page.locator('#restore-clear-previous').check();
    await page.locator('#confirm-restore').click();
    await page.locator('#restore-confirm').waitFor({ state: 'hidden' });
    const cleared = await state();
    assert.equal(cleared.requests.length, 1);
    assert.equal(cleared.requests[0].restoredFrom, published);
    assert.equal(cleared.requests[0].sequence, 4);
    // The loaded version is the draft's starting step and has its own preview.
    assert.notEqual(cleared.requests[0].presentationChanged, false);
    await page
      .locator('#timeline .progress-group[data-commit="' + cleared.head + '"] .show-version')
      .waitFor({ state: 'attached' });
    assert.equal(cleared.publishedCommit, published);
    assert.equal(cleared.releases[0].commit, release.commit);
    assert.equal(cleared.contentChanged, false);
    // A draft identical to the publication cannot be published again.
    assert.ok(!(cleared.publishableCommits || []).includes(cleared.head));
    assert.ok(!cleared.history.some((h: any) => h.commit === first));
    assert.equal((await fetch(origin + '/preview/versions/' + first + '/')).status, 404);
    assert.equal(await page.locator('#edits-tab').getAttribute('aria-selected'), 'true');
    assert.equal(
      await project.git(['rev-parse', cleared.head + ':site']),
      await project.git(['rev-parse', published + ':site']),
    );
    const retry = await post({
      commit: published,
      expectedHead: cleared.head,
      releaseId: release.id,
      historyMode: 'clear-all',
    });
    assert.equal(retry.status, 200);
    await project.git(['reset', '--hard', published]);
    const alreadyCurrent = await post({
      commit: published,
      expectedHead: published,
      releaseId: release.id,
      historyMode: 'clear-all',
    });
    assert.equal(alreadyCurrent.status, 200);
    assert.equal((await state()).head, published);
    assert.equal((await state()).contentChanged, false);
    assert.equal((await state()).releases[0].commit, release.commit);
  } finally {
    await browser?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
