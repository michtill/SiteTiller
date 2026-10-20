import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import { chromium } from 'playwright';
import { Project } from '../src/project.ts';
import { captureCmsPublication } from '../src/cms-publication.ts';
import { stepChanges } from '../src/step-changes.ts';
import { initialTeam, initialImages } from '../src/team.ts';
import { contentFixtureServer } from './fixtures/history-content-server.ts';
import { workflow } from './fixtures/workflow.ts';
const gateway = 'fixture-gateway-token';
const schema = {
    version: 1,
    folders: { docs: { type: 'file' } },
    lists: { items: { key: 'id', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
  },
  template =
    '<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>{{value "items" "one" "title"}}</h1><a href="/cms/files/docs/book.pdf">PDF</a><output id="dynamic"></output><output id="isolation"></output><output id="studio-access"></output></main><script type="module" src="/viewer.js"></script></body></html>';
async function setup(root: string) {
  const cms = join(root, 'cms');
  for (const dir of ['schema', 'data', 'media/docs']) await mkdir(join(cms, dir), { recursive: true });
  await writeFile(join(cms, 'schema/structure.json'), JSON.stringify(schema));
  await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Published"}]');
  await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nPublished');
  const project = new Project(join(root, 'studio/project'));
  await project.init(null);
  await project.write({
    'site/index.html': template.replace(/\{\{[^}]+\}\}/g, 'Entry'),
    'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/home.txt' } }),
    'site/templates/home.txt': template,
    'site/architecture.txt': 'Template renders items.title.',
    'site/viewer.js':
      "import {paint} from './viewer-helper.js';const rows=await(await fetch('cms/data/items.json')).json();paint(rows[0].title);try{parent.document.querySelector('#workspace');document.querySelector('#isolation').textContent='unsafe';}catch{document.querySelector('#isolation').textContent='isolated';}try{await(await fetch('/api/state')).json();document.querySelector('#studio-access').textContent='unsafe';}catch{document.querySelector('#studio-access').textContent='blocked';}",
    'site/viewer-helper.js': 'export function paint(value){document.querySelector("#dynamic").textContent=value;}',
  });
  await captureCmsPublication(project, cms);
  return { cms, project, initial: await project.head() };
}
test('AI-03: real content-only workflow produces a durable content step with its own preview, then combined changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-history-workflow-')),
    previous = { root: process.env.SITETILLER_CMS_ROOT, url: process.env.SITETILLER_CMS_URL };
  let owner: any;
  try {
    const { cms, project, initial } = await setup(root);
    owner = await contentFixtureServer(cms);
    process.env.SITETILLER_CMS_ROOT = cms;
    process.env.SITETILLER_CMS_URL = owner.origin;
    const slots = [{ provider: 'openai' as const, key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
      events: any[] = [];
    const content = await workflow(
      project,
      slots,
      'Změň pouze obsah',
      join(root, 'drafts'),
      (e) => events.push(e),
      async () => ({
        value: {
          action: 'implement',
          files: [
            { path: 'site/cms/data/items.json', content: '[{"id":"one","title":"Content only"}]' },
            {
              path: 'site/architecture.txt',
              content: 'Template still owns presentation; updated content remains in items.title.',
            },
          ],
        },
      }),
      undefined,
      [],
      { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
    );
    assert.ok(content.commit !== initial);
    // A content-only step has its own preview too (documentation 4.2).
    assert.equal(content.presentationChanged, true);
    assert.equal(content.changeKind, 'content');
    assert.equal(events.findLast((e) => e.stage === 'ready').presentationChanged, true);
    assert.equal(JSON.parse(await readFile(join(cms, 'data/items.json'), 'utf8'))[0].title, 'Content only');
    const combined = await workflow(
      project,
      slots,
      'Změň obsah i šablonu',
      join(root, 'drafts'),
      () => {},
      async (_c, _i, input) => {
        if (!input.files['site/templates/home.txt'])
          return { value: { action: 'read', paths: ['site/templates/home.txt'] } };
        return {
          value: {
            action: 'implement',
            files: [
              { path: 'site/cms/data/items.json', content: '[{"id":"one","title":"Combined"}]' },
              { path: 'site/templates/home.txt', content: template.replace('<h1>', '<h1 class="combined">') },
            ],
          },
        };
      },
      undefined,
      [],
      { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
    );
    assert.equal(combined.presentationChanged, true);
    assert.equal(combined.changeKind, 'combined');
  } finally {
    if (owner) await new Promise<void>((r) => owner.server.close(r));
    for (const [name, value] of [
      ['SITETILLER_CMS_ROOT', previous.root],
      ['SITETILLER_CMS_URL', previous.url],
    ])
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test('HI-10: named save/list/frozen preview/continue UI keeps the last step selected after restart and restores only unpublished content with CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-history-ui-'));
  let child: any, owner: any, browser: any;
  try {
    const { cms, project, initial } = await setup(root),
      published = join(root, 'published-cms');
    await cp(cms, published, { recursive: true });
    await mkdir(join(root, 'production'));
    const pointer = join(root, 'production/current.json');
    await writeFile(pointer, 'PUBLIC POINTER');
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Content step"}]');
    await captureCmsPublication(project, cms);
    const head = await project.head(),
      changes = await stepChanges(project, initial, head);
    const data = join(root, 'studio'),
      password = 'fixture-password',
      salt = 'fixture-salt';
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        password: { salt, hash: scryptSync(password, salt, 64).toString('hex') },
        slots: [],
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        automaticReasoningPolicy: 1,
        requests: [
          {
            id: 'presentation',
            sequence: 1,
            status: 'ready',
            commit: initial,
            prompt: 'Presentation step',
            presentationChanged: true,
          },
          { id: 'content', sequence: 2, status: 'ready', commit: head, prompt: 'Content step', ...changes },
        ],
        publishedCommit: initial,
        publishedThrough: 0,
        presentationHead: initial,
        presentationStepId: 'presentation',
      }),
    );
    owner = await contentFixtureServer(cms);
    const port = 22800 + Math.floor(Math.random() * 300),
      origin = 'http://127.0.0.1:' + port;
    const launch = async () => {
      child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
        windowsHide: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          SITETILLER_GATEWAY_TOKEN: gateway,
          SITETILLER_SHARED_AUTH_FILE: '',
          SITETILLER_DATA_DIR: data,
          SITETILLER_CMS_ROOT: cms,
          SITETILLER_CMS_URL: owner.origin,
          SITETILLER_CMS_PUBLISHED_ROOT: published,
          SITETILLER_PRODUCTION_HISTORY_DIR: '',
          SITETILLER_PUBLISH_URL: '',
          SITETILLER_ORIGIN: origin,
          SITETILLER_UI_LANGUAGE: 'cs',
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        stdio: 'ignore',
      });
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(origin + '/health')).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('Fixture server not ready');
    };
    const stop = async () => {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      child = null;
    };
    await launch();
    const post = (path: string, input: any, cookie = '') =>
      fetch(origin + '/api/' + path, {
        method: 'POST',
        headers: { Origin: origin, 'x-sitetiller-gateway': cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    assert.equal((await post('drafts/save', { name: 'Forbidden', expectedHead: head })).status, 401);
    const cookie = gateway,
      state = async () =>
        await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookie } })).json();
    assert.equal((await state()).presentationHead, head);
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', (error) => console.log('Fixture pageerror: ' + error.message));
    // The gateway header stands in for the Shell login. Subresources of the isolated preview frame get none: a custom
    // header would turn their cross-origin module requests into preflights that a real browser never sends.
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.frame() !== page.mainFrame() && request.resourceType() !== 'document') return route.continue();
      return route.continue({ headers: { ...request.headers(), 'x-sitetiller-gateway': gateway } });
    });
    await page.goto(origin);
    await page.waitForSelector('#workspace:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#workspace').hasAttribute('aria-busy'));
    await page.waitForSelector('#settings[open]');
    await page.locator('#close-settings').click();
    await page.locator('#cms-preview-choice > summary').click();
    await page.locator('[data-content-source="unpublished"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-group-id="content"] .show-version')?.getAttribute('aria-pressed') === 'true',
    );
    // The content step has its own preview (documentation 4.2) and no note about a missing one.
    assert.equal(await page.locator('[data-group-id="content"] .content-step-note').count(), 0);
    // The status names the current draft commit; the preview shows the last step.
    await page.waitForFunction(
      (commit) => document.querySelector('#publish-status').textContent.includes(commit),
      head.slice(0, 8),
    );
    await page.waitForFunction(() =>
      document.querySelector('#preview').getAttribute('src').includes('sources/unpublished'),
    );
    assert.equal(await page.frameLocator('#preview').locator('h1').textContent(), 'Content step');
    // Editor edits after the last presentation/content checkpoint must be captured at save time.
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Saved current Editor"}]');
    await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nSaved current Editor');
    const beforeRequests = JSON.stringify((await state()).requests),
      writesBefore = owner.writes;
    await page.locator('#save-draft').click();
    await page.locator('#draft-name').fill('Human selected state');
    // Unchecked "remove previous steps": the steps do not change.
    assert.equal(await page.locator('#save-clear-previous').isChecked(), true);
    await page.locator('#save-clear-previous').uncheck();
    const savedResponse = page.waitForResponse((r) => r.url().endsWith('/api/drafts/save'), { timeout: 180000 });
    await page.locator('#confirm-save-draft').click();
    const saveResponse = await savedResponse;
    assert.equal(saveResponse.status(), 200, await saveResponse.text());
    await page.locator('#save-draft-dialog').waitFor({ state: 'hidden' });
    let snapshot = (await state()).savedDrafts[0];
    assert.ok(snapshot);
    assert.match((await project.committedFiles(snapshot.commit))['site/cms/data/items.json'], /Saved current Editor/);
    assert.equal(await project.head(), head);
    assert.equal(owner.writes, writesBefore);
    assert.equal(JSON.stringify((await state()).requests), beforeRequests);
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Later Editor"}]');
    await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nLater Editor');
    await page.locator('#drafts-tab').click();
    const leaseResponse = page.waitForResponse((r) => r.url().endsWith('/api/drafts/preview'), { timeout: 180000 }),
      documentResponse = page.waitForResponse(
        (r) =>
          r.url().includes('/preview/drafts/' + snapshot.id + '/access/') && r.request().resourceType() === 'document',
        { timeout: 180000 },
      );
    await page.locator('.saved-draft-card').first().click();
    const leaseReply = await leaseResponse;
    assert.equal(leaseReply.status(), 200, await leaseReply.text());
    const access = await leaseReply.json();
    const frozenDocument = await documentResponse;
    assert.equal(frozenDocument.status(), 200, await frozenDocument.text());
    assert.match(await frozenDocument.text(), /Saved current Editor/);
    const leasedData = await fetch(origin + access.url + 'cms/data/items.json');
    assert.equal(leasedData.status, 200);
    assert.equal(leasedData.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await leasedData.json())[0].title, 'Saved current Editor');
    await page.frameLocator('#preview').locator('h1').filter({ hasText: 'Saved current Editor' }).waitFor();
    assert.equal(await page.frameLocator('#preview').locator('h1').textContent(), 'Saved current Editor');
    await page
      .frameLocator('#preview')
      .locator('#dynamic')
      .filter({ hasText: 'Saved current Editor' })
      .waitFor({ timeout: 180000 });
    assert.equal(await page.frameLocator('#preview').locator('#dynamic').textContent(), 'Saved current Editor');
    await page.frameLocator('#preview').locator('#studio-access').filter({ hasText: 'blocked' }).waitFor();
    assert.equal(await page.frameLocator('#preview').locator('#isolation').textContent(), 'isolated');
    assert.ok(!(await page.locator('#preview').getAttribute('sandbox')).includes('allow-same-origin'));
    assert.equal((await fetch(origin + '/preview/drafts/' + snapshot.id + '/')).status, 401);
    assert.equal((await post('drafts/preview', { id: snapshot.id })).status, 401);
    assert.match(
      await (
        await fetch(origin + '/preview/drafts/' + snapshot.id + '/cms/files/docs/book.pdf', {
          headers: { 'x-sitetiller-gateway': cookie },
        })
      ).text(),
      /Saved current Editor/,
    );
    assert.equal(await page.locator('#publish').isEnabled(), false);
    assert.equal(await page.locator('#cms-preview-choice').isVisible(), false);
    await page.locator('#edits-tab').click();
    // The step the draft was saved from (the current draft, a content step) carries its name.
    assert.equal(
      await page.locator('[data-group-id="content"] .step-badge[data-badge="saved"]').textContent(),
      'Uloženo: Human selected state',
    );
    // The presentation step is the published one (a version from before numbering, so without a number).
    assert.deepEqual(await page.locator('[data-group-id="presentation"] .step-badge').allTextContents(), [
      'Publikováno',
    ]);
    await stop();
    await launch();
    const cookieAgain = gateway;
    await page.reload();
    await page.waitForSelector('#workspace:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#workspace').hasAttribute('aria-busy'));
    // The same model problem opens the AI settings only once per browser.
    assert.equal(await page.locator('#settings[open]').count(), 0);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-group-id="content"] .show-version')?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(
      (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookieAgain } })).json())
        .presentationHead,
      head,
    );
    const prepared = await (
      await post('restore/prepare', { draftId: snapshot.id, commit: snapshot.commit, expectedHead: head }, cookieAgain)
    ).json();
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Conflict"}]');
    assert.equal(
      (
        await post(
          'restore',
          {
            draftId: snapshot.id,
            commit: snapshot.commit,
            expectedHead: head,
            confirmContentRestore: true,
            contentRevision: prepared.revision,
            historyMode: 'keep',
          },
          cookieAgain,
        )
      ).status,
      400,
    );
    assert.equal(await project.head(), head);
    await page.locator('#drafts-tab').click();
    await page.locator('.saved-draft-card').last().click();
    await page.locator('#restore-preview:not([hidden])').click();
    await page.waitForFunction(() => !document.querySelector('#confirm-restore').disabled);
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    await page.locator('#restore-clear-previous').uncheck();
    const restoreResponse = page.waitForResponse((r) => r.url().endsWith('/api/restore'), { timeout: 180000 });
    await page.locator('#confirm-restore').click();
    const restoreReply = await restoreResponse;
    assert.equal(restoreReply.status(), 200, await restoreReply.text());
    await page.locator('#restore-confirm').waitFor({ state: 'hidden' });
    assert.equal(JSON.parse(await readFile(join(cms, 'data/items.json'), 'utf8'))[0].title, 'Saved current Editor');
    assert.match(await readFile(join(cms, 'media/docs/book.pdf'), 'utf8'), /Saved current Editor/);
    assert.equal(JSON.parse(await readFile(join(published, 'data/items.json'), 'utf8'))[0].title, 'Published');
    assert.equal(await readFile(pointer, 'utf8'), 'PUBLIC POINTER');
    assert.equal(await project.git(['rev-parse', snapshot.ref]), snapshot.commit);
    assert.equal(
      (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookieAgain } })).json())
        .savedDrafts.length,
      1,
    );
    const freshState = await (
        await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': cookieAgain } })
      ).json(),
      again = await (
        await post(
          'restore/prepare',
          { draftId: snapshot.id, commit: snapshot.commit, expectedHead: freshState.head },
          cookieAgain,
        )
      ).json();
    const clear = await post(
      'restore',
      {
        draftId: snapshot.id,
        commit: snapshot.commit,
        expectedHead: freshState.head,
        confirmContentRestore: true,
        contentRevision: again.revision,
        historyMode: 'clear-all',
      },
      cookieAgain,
    );
    assert.equal(clear.status, 200, await clear.text());
    assert.equal(await project.git(['rev-parse', snapshot.ref]), snapshot.commit);
    assert.equal(await readFile(pointer, 'utf8'), 'PUBLIC POINTER');
    assert.ok((await project.git(['for-each-ref', 'refs/sitetiller/recovery/'])).length > 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#drafts-tab').isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: 'work/history-phase1-fixture-mobile.png', fullPage: true });
  } finally {
    if (browser) await browser.close();
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    if (owner) await new Promise<void>((r) => owner.server.close(r));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
