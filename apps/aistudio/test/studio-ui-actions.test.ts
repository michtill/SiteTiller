import { previewDocument } from '../src/preview-document.ts';
import { studioAsset } from './fixtures/studio-assets.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { initialTeam, initialImages } from '../src/team.ts';
test('HI-01: real Studio UI menu, language priority, responsive tabs, version actions and exact request targets', async () => {
  const head = 'b'.repeat(40),
    previous = 'a'.repeat(40),
    published = 'c'.repeat(40),
    older = 'd'.repeat(40),
    saved = 'e'.repeat(40),
    calls: any[] = [],
    errors: string[] = [];
  let state: any = {
    versionActions: 1,
    networkMode: 'offline',
    head,
    presentationHead: head,
    providers: [],
    roles: initialTeam(),
    imageModels: initialImages(),
    history: [head, previous, published, older].map((commit) => ({ commit })),
    requests: [
      {
        id: 'one',
        sequence: 1,
        status: 'ready',
        commit: previous,
        baseCommit: published,
        prompt: 'First',
        presentationChanged: true,
        progress: [{ stage: 'ready', commit: previous }],
      },
      {
        id: 'two',
        sequence: 2,
        status: 'ready',
        commit: head,
        baseCommit: previous,
        prompt: 'Last',
        presentationChanged: true,
        progress: [{ stage: 'ready', commit: head }],
      },
    ],
    events: [],
    job: null,
    busy: false,
    hasLoadedReality: true,
    hasDraftSteps: true,
    hasUnpublishedWork: true,
    publishConfigured: true,
    publishableCommits: [previous, head],
    publishedCommit: published,
    releases: [
      { id: 'release-old', number: 0, commit: older, publishedAt: '2026-10-10T12:00:00Z' },
      { id: 'release-current', number: 1, commit: published, publishedAt: '2026-10-11T12:00:00Z' },
    ],
    cmsPreviewSources: {},
    savedDrafts: [{ id: 'draft-' + '1'.repeat(32), commit: saved, name: 'Named', createdAt: '2026-10-11T12:00:00Z' }],
  };
  let origin = '',
    browser;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname.slice(5);
        let body: any = {};
        if (req.method === 'POST') {
          let text = '';
          for await (const chunk of req) text += chunk;
          body = JSON.parse(text || '{}');
          calls.push({ path, body });
        }
        let value: any = {};
        if (path === 'session') value = { authenticated: true, configured: true, sharedLogin: true };
        else if (path === 'state') value = { ...state, previewUrl: origin + '/preview/' };
        else if (path === 'models') value = { models: [], issues: [], optionalIssues: [] };
        else if (path === 'design-content-status') value = { unpublished: false };
        else if (path === 'drafts/preview') value = { url: '/preview/drafts/' + body.id + '/access/fixture/' };
        else if (path === 'restore/prepare') value = { hasContent: false };
        else if (path === 'publish')
          value = { ok: true, release: { id: 'fixture-published-step', commit: body.commit, number: 2 } };
        else if (path === 'drafts/remove') {
          state.savedDrafts = state.savedDrafts.filter((d) => d.id !== body.id);
          value = { removed: body.id };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
        return;
      }
      if (url.pathname.startsWith('/preview/')) {
        const commit =
          url.pathname.match(/[a-f0-9]{40}/)?.[0] ||
          state.savedDrafts.find((d) => url.pathname.includes(d.id))?.commit ||
          head;
        res.end(
          req.method === 'HEAD'
            ? ''
            : previewDocument(
                '<html><head><title>Frozen preview</title></head><body>Frozen preview</body></html>',
                commit,
                true,
              ),
        );
        return;
      }
      const asset = await studioAsset(url.pathname, 'cs');
      if (!asset) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader('Content-Type', asset.type);
      res.end(asset.body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      if (window === window.top) localStorage.setItem('sitetiller-language', 'en');
    });
    await page.goto(origin);
    await page.waitForFunction(
      () =>
        !document.getElementById('workspace')!.hasAttribute('aria-busy') &&
        !document.querySelector('.release-actions')!.hasAttribute('hidden'),
    );
    assert.equal(await page.locator('html').getAttribute('lang'), 'cs');
    assert.equal(await page.locator('#interface-language').count(), 0);
    assert.equal(await page.locator('.studio-header .icon-button').count(), 0);
    assert.equal(await page.locator('.preview-actions #theme-toggle').count(), 1);
    assert.equal(await page.locator('.release-actions #save-draft').count(), 1);
    await page.locator('#studio-switcher summary').click();
    const labels = await page.locator('#studio-switcher nav>:is(a,button)').allTextContents();
    assert.deepEqual(labels, ['Editor obsahu', 'AI Studio', 'Nastavení', 'Odhlásit']);
    await page.locator('#studio-switcher summary').click();
    await page.evaluate(() => (document.getElementById('workspace')!.style.gridTemplateColumns = '700px 1fr'));
    let ys = await page
      .locator('.workspace-tabs button')
      .evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().top)));
    assert.equal(new Set(ys).size, 1);
    await page.evaluate(() => (document.getElementById('workspace')!.style.gridTemplateColumns = '280px 1fr'));
    ys = await page
      .locator('.workspace-tabs button')
      .evaluateAll((elements) => elements.map((el) => Math.round(el.getBoundingClientRect().top)));
    const menuBottom = await page
      .locator('#studio-switcher summary')
      .evaluate((el) => el.getBoundingClientRect().bottom);
    assert.ok(
      ys[0] >= Math.round(menuBottom),
      'Tabs must wrap below the menu when the actual chat column cannot fit both',
    );
    await page.evaluate(() => (document.getElementById('workspace')!.style.gridTemplateColumns = '700px 1fr'));
    assert.equal(await page.locator('#delete-preview').isVisible(), true);
    assert.equal(await page.locator('#save-draft').textContent(), 'Uložit');
    await page.locator('#delete-preview').click();
    await page.locator('#confirm-restore').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('confirm-restore')!.disabled);
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    assert.equal(await page.locator('#restore-clear-previous').isDisabled(), true);
    await page.locator('#confirm-restore').click();
    await page.locator('#restore-confirm').waitFor({ state: 'hidden' });
    const deleted = calls.findLast((c) => c.path === 'restore');
    assert.equal(deleted.body.commit, previous);
    assert.equal(deleted.body.deleteStepId, 'two');
    assert.equal(deleted.body.historyMode, 'rewind');
    assert.equal(deleted.body.expectedHead, head);
    assert.equal(await page.locator('.step-actions').count(), 0);
    await page.locator('[data-group-id="one"] .show-version').click();
    await page.waitForFunction(
      () => document.querySelector('[data-group-id="one"] .show-version')?.getAttribute('aria-pressed') === 'true',
    );
    await page.waitForFunction(() => {
      const area = document.querySelector('.release-actions') as HTMLElement;
      return !!area && !area.hidden && !(document.getElementById('restore-preview') as HTMLElement).hidden;
    });
    assert.equal(await page.locator('#restore-preview').textContent(), 'Vrátit se sem');
    assert.equal(await page.locator('#publish').textContent(), 'Publikovat tento krok');
    const sourceBeforeSave = JSON.stringify([state.head, state.requests]),
      restoresBeforeSave = calls.filter((c) => c.path === 'restore').length;
    await page.locator('#save-draft').click();
    await page.locator('#draft-name').fill('Historical');
    await page.locator('#confirm-save-draft').click();
    await page.locator('#save-draft-dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.findLast((c) => c.path === 'drafts/save').body.commit, previous);
    assert.equal(calls.findLast((c) => c.path === 'drafts/save').body.cmsSource, undefined);
    assert.equal(JSON.stringify([state.head, state.requests]), sourceBeforeSave);
    assert.equal(calls.filter((c) => c.path === 'restore').length, restoresBeforeSave);
    await page.locator('#publish').click();
    await page.locator('#publish-confirm').waitFor({ state: 'visible' });
    await page.locator('#confirm-publish').click();
    await page.locator('#publish-confirm').waitFor({ state: 'hidden' });
    assert.equal(calls.findLast((c) => c.path === 'publish').body.commit, previous);
    assert.equal(calls.findLast((c) => c.path === 'publish').body.stepId, 'one');
    assert.equal(calls.findLast((c) => c.path === 'publish').body.expectedHead, head);
    await page.locator('#history-toggle').click();
    assert.equal(await page.locator('#history .saved-draft-actions').count(), 0);
    await page.locator('#drafts-tab').click();
    assert.equal(await page.locator('#saved-drafts button').count(), 0);
    await page.locator('.saved-draft-card').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.release-actions')!.getAttribute('data-kind') === 'saved' &&
        !document.querySelector('.release-actions')!.hasAttribute('hidden'),
    );
    const workBefore = JSON.stringify([state.head, state.requests, state.releases]);
    // The app's confirm dialog (packages/ui), not the browser's.
    await page.locator('#delete-preview').click();
    // The library's layout in the AI Studio colours (its styles load as a file: no inline styles here).
    assert.deepEqual(
      await page
        .locator('dialog.ui-confirm')
        .evaluate((d) => [
          getComputedStyle(d).backgroundColor,
          getComputedStyle(d.querySelector('footer')).justifyContent,
          getComputedStyle(d.querySelector('.ui-confirm-ok')).backgroundColor,
        ]),
      ['rgb(24, 26, 34)', 'flex-end', 'rgb(214, 250, 114)'],
    );
    await page.locator('dialog.ui-confirm .ui-confirm-ok').click();
    await page.waitForFunction(() => !document.querySelector('.saved-draft-card'));
    assert.equal(JSON.stringify([state.head, state.requests, state.releases]), workBefore);
    assert.equal(calls.findLast((c) => c.path === 'drafts/remove').body.commit, saved);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
