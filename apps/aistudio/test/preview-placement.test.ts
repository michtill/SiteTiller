import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { initialTeam, initialImages } from '../src/team.ts';
import { previewDocument } from '../src/preview-document.ts';
import { studioAsset } from './fixtures/studio-assets.ts';
const head = 'b'.repeat(40),
  previous = 'a'.repeat(40),
  published = 'c'.repeat(40),
  older = 'd'.repeat(40),
  saved = 'e'.repeat(40),
  saved2 = 'f'.repeat(40),
  draftId = 'draft-' + '1'.repeat(32),
  draft2Id = 'draft-' + '2'.repeat(32);
async function fixture(run: any, language = 'cs') {
  const previewGets = new Map<string, number>(),
    calls: any[] = [],
    errors: string[] = [],
    headDelay = new Map<string, number>(),
    accessDelay = new Map<string, number>(),
    failHeads = new Set<string>();
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
    cmsPreviewSources: { published: true, unpublished: true },
    savedDrafts: [
      { id: draftId, commit: saved, name: 'Named 日本語', createdAt: '2026-10-11T12:00:00Z' },
      { id: draft2Id, commit: saved2, name: 'Second saved', createdAt: '2026-10-11T12:01:00Z' },
    ],
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
        else if (path === 'drafts/preview') {
          if (accessDelay.has(body.id)) await new Promise((r) => setTimeout(r, accessDelay.get(body.id)));
          value = { url: '/preview/drafts/' + body.id + '/access/fixture/' };
        } else if (path === 'restore/prepare')
          value = { hasContent: true, revision: '0'.repeat(64), collections: 1, files: 0 };
        else if (path === 'publish') {
          value = { ok: true, release: { id: 'fixture-published-step', commit: body.commit, number: 2 } };
          state.releases.push(value.release);
        } else if (path === 'drafts/remove') {
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
        if (req.method === 'HEAD' && headDelay.has(commit))
          await new Promise((r) => setTimeout(r, headDelay.get(commit)));
        if (failHeads.has(commit)) {
          res.writeHead(503);
          res.end('Preview unavailable');
          return;
        }
        if (req.method === 'GET') previewGets.set(commit, (previewGets.get(commit) || 0) + 1);
        res.setHeader('Content-Type', 'text/html');
        res.end(
          req.method === 'HEAD'
            ? ''
            : previewDocument(
                '<html><head><title>Fixture ' +
                  commit.slice(0, 8) +
                  '</title></head><body><h1>' +
                  commit +
                  '</h1></body></html>',
                commit,
                true,
              ),
        );
        return;
      }
      const asset = await studioAsset(url.pathname, language);
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await ready(page, 'step', 'two', head);
    await run({ page, state, calls, headDelay, accessDelay, failHeads, origin, previewGets });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
async function ready(page: any, kind: string, id: string, commit: string) {
  await page.waitForFunction(
    ({ kind, id, commit }) => {
      const area = document.querySelector('.release-actions') as HTMLElement,
        frame = document.querySelector('#preview') as HTMLElement;
      return (
        !!area &&
        !area.hidden &&
        area.dataset.kind === kind &&
        area.dataset.selectionId === id &&
        area.dataset.commit === commit &&
        frame?.dataset.commit === commit
      );
    },
    { kind, id, commit },
  );
}
const labels = (page) => page.locator('.release-actions button:visible').allTextContents();
test('HI-01: one below-preview action area, no history mutations; previous Save/Publish and restore use frozen exact target across tabs', () =>
  fixture(async ({ page, state, calls }) => {
    assert.deepEqual(await labels(page), ['Odstranit', 'Uložit', 'Publikovat']);
    assert.equal(await page.locator('#timeline .step-actions,#saved-drafts button,#history button').count(), 0);
    await page.locator('[data-group-id=one] .show-version').click();
    await ready(page, 'step', 'one', previous);
    assert.deepEqual(await labels(page), ['Vrátit se sem', 'Uložit', 'Publikovat tento krok']);
    const geometry = await page.locator('.release-actions').evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      frameBottom: document.getElementById('preview')!.getBoundingClientRect().bottom,
    }));
    assert.ok(geometry.top >= geometry.frameBottom);
    for (const tab of ['drafts-tab', 'history-toggle']) {
      await page.locator('#' + tab).click();
      assert.equal(await page.locator('.release-actions').getAttribute('data-selection-id'), 'one');
      assert.equal(await page.locator('#preview').getAttribute('data-commit'), previous);
    }
    // The edits tab always opens on the latest edit; the earlier step is selected again.
    await page.locator('#edits-tab').click();
    await page.waitForFunction((h) => document.getElementById('preview')!.getAttribute('data-commit') === h, head);
    await page.locator('[data-group-id=one] .show-version').click();
    await ready(page, 'step', 'one', previous);
    await page.locator('#save-draft').click();
    await page.locator('#draft-name').fill('Frozen step');
    await page.locator('#confirm-save-draft').click();
    await page.locator('#save-draft-dialog').waitFor({ state: 'hidden' });
    const save = calls.findLast((c) => c.path === 'drafts/save');
    assert.equal(save.body.commit, previous);
    assert.equal(save.body.expectedHead, head);
    assert.equal(save.body.cmsSource, undefined);
    assert.equal(state.head, head);
    await page.locator('#restore-preview').click();
    await page.waitForFunction(() => !document.getElementById('confirm-restore')!.disabled);
    assert.equal(await page.locator('#restore-confirm').getAttribute('data-step-id'), 'one');
    assert.equal(await page.locator('#restore-confirm').getAttribute('data-commit'), previous);
    await page.locator('#cancel-restore').click();
    await page.locator('#publish').click();
    // "Remove previous steps" is on by default.
    assert.equal(await page.locator('#publish-clear-previous').isChecked(), true);
    await page.locator('#confirm-publish').click();
    await page.locator('#publish-confirm').waitFor({ state: 'hidden' });
    const publish = calls.findLast((c) => c.path === 'publish');
    assert.equal(publish.body.clearPrevious, true);
    assert.equal(publish.body.commit, previous);
    assert.equal(publish.body.stepId, 'one');
    assert.equal(publish.body.expectedHead, head);
  }));
test('HI-01: saved row text/eye/Enter/Space select same frozen preview without mutation; publications show only contextual return/load', () =>
  fixture(async ({ page, calls }) => {
    await page.locator('#drafts-tab').click();
    const card = page.locator('[data-draft-id="' + draftId + '"]');
    assert.equal(await card.locator('button,a,input').count(), 0);
    await card.locator('strong').click();
    await ready(page, 'saved', draftId, saved);
    assert.deepEqual(await labels(page), ['Načíst do úprav', 'Odstranit']);
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    await card.locator('.selector-eye').click();
    await ready(page, 'saved', draftId, saved);
    for (const key of ['Enter', 'Space']) {
      await card.focus();
      await card.press(key);
      await ready(page, 'saved', draftId, saved);
    }
    assert.equal(calls.filter((c) => !['drafts/preview'].includes(c.path)).length, 0);
    await page.locator('#restore-preview').click();
    await page.waitForFunction(() => !document.getElementById('confirm-restore')!.disabled);
    assert.equal(await page.locator('#restore-confirm').getAttribute('data-draft-id'), draftId);
    assert.equal(await page.locator('#restore-confirm').getAttribute('data-commit'), saved);
    await page.locator('#cancel-restore').click();
    await page.locator('#history-toggle').click();
    await page.locator('[data-release-id=release-current]').click();
    await ready(page, 'release', 'release-current', published);
    assert.deepEqual(await labels(page), ['Vrátit se sem']);
    await page.locator('#restore-preview').click();
    assert.equal(await page.locator('#restore-confirm').getAttribute('data-release-id'), 'release-current');
    await page.locator('#cancel-restore').click();
    await page.locator('[data-release-id=release-old]').click();
    await ready(page, 'release', 'release-old', older);
    assert.deepEqual(await labels(page), ['Načíst do úprav']);
    assert.equal(await page.locator('#history button,#saved-drafts button').count(), 0);
  }));
test('HI-02: rapid selections with delayed access/HEAD cannot retarget actions; preview failure keeps coherent old preview/action pair', () =>
  fixture(async ({ page, headDelay, accessDelay, failHeads, calls }) => {
    headDelay.set(previous, 450);
    await page.locator('[data-group-id=one] .show-version').click();
    await page.waitForFunction(() => document.querySelector('.release-actions')!.hasAttribute('hidden'));
    await page.locator('[data-group-id=two] .show-version').click();
    await ready(page, 'step', 'two', head);
    await page.waitForTimeout(500);
    await ready(page, 'step', 'two', head);
    await page.locator('#drafts-tab').click();
    accessDelay.set(draftId, 450);
    await page.locator('[data-draft-id="' + draftId + '"]').click();
    await page.locator('[data-draft-id="' + draft2Id + '"]').click();
    await ready(page, 'saved', draft2Id, saved2);
    await page.waitForTimeout(500);
    await ready(page, 'saved', draft2Id, saved2);
    failHeads.add(saved);
    await page.locator('[data-draft-id="' + draftId + '"]').click();
    await page.locator('.release-actions').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.includes('Náhled se nepodařilo'));
    await ready(page, 'saved', draft2Id, saved2);
    assert.equal(await page.locator('[data-draft-id="' + draft2Id + '"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await labels(page), ['Načíst do úprav', 'Odstranit']);
    assert.equal(calls.filter((c) => c.path !== 'drafts/preview').length, 0);
  }));
test('HI-04: bottom Delete uses exact latest predecessor and exact named snapshot; saved/published state stays separate', () =>
  fixture(async ({ page, state, calls }) => {
    await page.locator('#delete-preview').click();
    await page.waitForFunction(() => !document.getElementById('confirm-restore')!.disabled);
    assert.equal(await page.locator('#restore-clear-previous').isChecked(), true);
    assert.equal(await page.locator('#restore-clear-previous').isDisabled(), true);
    await page.locator('#confirm-restore').click();
    await page.locator('#restore-confirm').waitFor({ state: 'hidden' });
    const restore = calls.findLast((c) => c.path === 'restore');
    assert.equal(restore.body.commit, previous);
    assert.equal(restore.body.deleteStepId, 'two');
    assert.equal(restore.body.expectedHead, head);
    assert.equal(restore.body.historyMode, 'rewind');
    assert.equal(restore.body.stepId, undefined);
    assert.equal(restore.body.confirmContentRestore, true);
    assert.equal(restore.body.contentRevision, '0'.repeat(64));
    await page.locator('#drafts-tab').click();
    await page.locator('[data-draft-id="' + draftId + '"]').click();
    await ready(page, 'saved', draftId, saved);
    const publicBefore = JSON.stringify(state.releases);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#delete-preview').click();
    await page.waitForFunction((id) => !document.querySelector('[data-draft-id="' + id + '"]'), draftId);
    const remove = calls.findLast((c) => c.path === 'drafts/remove');
    assert.deepEqual(remove.body, { id: draftId, commit: saved, expectedHead: head });
    assert.equal(state.head, head);
    assert.equal(JSON.stringify(state.releases), publicBefore);
    assert.equal(state.savedDrafts.length, 1);
  }));
test('HI-01: content popover crosses split above iframe at wide/narrow chat widths, remains clickable on resize/scroll, closes Escape/outside', () =>
  fixture(async ({ page }) => {
    // The chat column is set narrower than the popover, so the popover must cross the split whatever the fonts.
    await page.locator('#cms-preview-choice summary').click();
    await page.locator('#content-source-popover').waitFor({ state: 'visible' });
    const popoverWidth = await page
      .locator('#content-source-popover')
      .evaluate((el) => Math.floor(el.getBoundingClientRect().width));
    await page.keyboard.press('Escape');
    for (const width of [popoverWidth - 20, popoverWidth - 80]) {
      await page.evaluate(
        (width) => (document.getElementById('workspace')!.style.gridTemplateColumns = width + 'px 10px 1fr'),
        width,
      );
      await page.locator('#cms-preview-choice summary').click();
      await page.locator('#content-source-popover').waitFor({ state: 'visible' });
      const placement = await page.locator('#content-source-popover').evaluate((el) => {
        const r = el.getBoundingClientRect(),
          iframe = document.getElementById('preview')!.getBoundingClientRect(),
          x = Math.min(r.right - 12, Math.max(r.left + 12, iframe.left + 10)),
          y = r.top + 55;
        return {
          insideViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          crosses: r.right > iframe.left,
          aboveIframe: !!document.elementFromPoint(x, y)?.closest('#content-source-popover'),
          body: el.parentElement === document.body,
        };
      });
      assert.deepEqual(placement, { insideViewport: true, crosses: true, aboveIframe: true, body: true });
      await page.locator('#content-source-popover [data-content-source=unpublished]').click();
      assert.equal(await page.locator('#cms-preview-source').inputValue(), 'unpublished');
      await ready(page, 'step', 'two', head);
      await page.locator('#cms-preview-choice summary').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#content-source-popover').isVisible(), false);
      assert.equal(
        await page.locator('#cms-preview-choice summary').evaluate((el) => el === document.activeElement),
        true,
      );
      await page.locator('#cms-preview-choice summary').click();
      await page.locator('#content-source-popover').waitFor({ state: 'visible' });
      await page.locator('.preview-toolbar').click();
      assert.equal(await page.locator('#content-source-popover').isVisible(), false);
    }
    await page.locator('#cms-preview-choice summary').click();
    await page.locator('#content-source-popover').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 620, height: 500 });
    await page.evaluate(() => window.scrollTo(0, 100));
    await page.waitForFunction(() => {
      const r = document.getElementById('content-source-popover')!.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    });
    await page.locator('#content-source-popover [data-content-source=published]').click();
    assert.equal(await page.locator('#cms-preview-source').inputValue(), 'published');
  }));

test('CO-01: legacy current eye works without current history entry and content-only steps create no new selector', () =>
  fixture(async ({ page, state }) => {
    state.history = [{ commit: published }, { commit: older }];
    delete state.requests[1].presentationChanged;
    await page.waitForTimeout(1700);
    const eye = page.locator('[data-group-id=two] .show-version');
    assert.equal(await eye.isEnabled(), true);
    await page.locator('[data-group-id=one] .show-version').click();
    await ready(page, 'step', 'one', previous);
    await eye.click();
    await ready(page, 'step', 'two', head);
    await page.locator('#drafts-tab').click();
    await page.locator('[data-draft-id="' + draftId + '"]').click();
    await ready(page, 'saved', draftId, saved);
    // The edits tab always opens on the latest edit.
    await page.locator('#edits-tab').click();
    await page.waitForFunction((h) => document.getElementById('preview')!.getAttribute('data-commit') === h, head);
    const content = '9'.repeat(40);
    state.head = content;
    state.requests.push({
      id: 'content',
      sequence: 3,
      status: 'ready',
      commit: content,
      baseCommit: head,
      presentationChanged: false,
      changeKind: 'content',
      prompt: 'Content only',
      progress: [{ stage: 'ready', commit: content }],
    });
    await ready(page, 'step', 'content', content);
    assert.equal(await page.locator('[data-group-id=content] .show-version').count(), 0);
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    await page.locator('#history-toggle').click();
    await page.locator('[data-release-id=release-current]').click();
    await ready(page, 'release', 'release-current', published);
    await page.locator('#edits-tab').click();
    await eye.click();
    await ready(page, 'step', 'content', content);
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
  }));

test('HI-02: prepared iframe keeps its loaded browsing context: one document GET per selection and immediately rendered body matches action commit', () =>
  fixture(async ({ page, previewGets }) => {
    await page.frameLocator('#preview').locator('h1').waitFor();
    assert.equal(await page.frameLocator('#preview').locator('h1').textContent(), head);
    assert.equal(previewGets.get(head), 1);
    await page.locator('[data-group-id=one] .show-version').click();
    await ready(page, 'step', 'one', previous);
    assert.equal(await page.frameLocator('#preview').locator('h1').textContent(), previous);
    assert.equal(previewGets.get(previous), 1);
    await page.locator('#history-toggle').click();
    await page.locator('[data-release-id=release-current]').click();
    await ready(page, 'release', 'release-current', published);
    assert.equal(await page.frameLocator('#preview').locator('h1').textContent(), published);
    assert.equal(previewGets.get(published), 1);
  }));

for (const language of ['cs', 'en'])
  test('HI-02: immediate pending feedback for all kinds, keyboard and repeated clicks: ' + language, () =>
    fixture(async ({ page, headDelay, accessDelay, calls, previewGets }) => {
      const message = language === 'cs' ? 'Načítám náhled…' : 'Loading preview…';
      await page.evaluate(() => (document.getElementById('workspace').style.gridTemplateColumns = '280px 10px 1fr'));
      const geometry = new Map();
      async function remember(selector) {
        geometry.set(
          selector,
          await page.locator(selector).evaluate((el) => {
            const slot = el.matches('button') ? el : el.querySelector('.selector-eye'),
              r = slot.getBoundingClientRect(),
              row = el.closest('article').getBoundingClientRect(),
              frame = document.getElementById('preview').getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, rowHeight: row.height, frameY: frame.y };
          }),
        );
      }
      async function pending(selector, oldCommit) {
        const row = page.locator(selector);
        assert.equal(await row.getAttribute('aria-busy'), 'true');
        assert.equal(await row.getAttribute('aria-pressed'), 'true');
        assert.equal(await row.locator('.preview-spinner').count(), 1);
        assert.equal(await row.evaluate((el) => el.closest('article').classList.contains('preview-active')), true);
        assert.equal(await page.locator('article.preview-active:visible').count(), 1);
        assert.equal(await page.locator('#preview-loading-status').textContent(), message);
        assert.equal(
          await page.locator('#preview-loading-status').evaluate((el) => getComputedStyle(el).clipPath),
          'inset(50%)',
        );
        assert.equal(await page.locator('.preview-pending-label').count(), 0);
        assert.equal(await page.locator('#preview').getAttribute('data-commit'), oldCommit);
        assert.equal(await page.locator('.release-actions').isVisible(), false);
        assert.equal(await row.evaluate((el) => getComputedStyle(el).outlineStyle === 'dashed'), false);
        const before = geometry.get(selector);
        await remember(selector);
        assert.deepEqual(geometry.get(selector), before);
        assert.equal(before.width, 32);
        assert.equal(before.height, 32);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(
          await row.locator('.preview-spinner').evaluate((el) => getComputedStyle(el).animationName),
          'none',
        );
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        assert.equal(
          await row.locator('.preview-spinner').evaluate((el) => getComputedStyle(el).animationName),
          'preview-spin',
        );
      }

      headDelay.set(previous, 1100);
      const step = '[data-group-id=one] button.show-version';
      await remember(step);
      await page.locator(step).focus();
      await page.locator(step).press('Enter');
      await pending(step, head);
      await page.locator(step).click();
      await page.locator(step).press('Space');
      await ready(page, 'step', 'one', previous);
      assert.equal(previewGets.get(previous), 1);
      assert.equal(await page.locator('.preview-pending').count(), 0);
      await page.locator('#history-toggle').click();
      headDelay.set(published, 1100);
      const release = '#history [data-release-id=release-current]';
      await remember(release);
      await page.locator(release).click();
      await pending(release, previous);
      await page.locator(release).click();
      await ready(page, 'release', 'release-current', published);
      assert.equal(previewGets.get(published), 1);
      await page.locator('#drafts-tab').click();
      accessDelay.set(draftId, 1100);
      const draft = '[data-draft-id="' + draftId + '"]';
      await remember(draft);
      await page.locator(draft).focus();
      await page.locator(draft).press('Space');
      await pending(draft, published);
      await page.locator(draft).click();
      await page.locator(draft).press('Enter');
      await ready(page, 'saved', draftId, saved);
      assert.equal(calls.filter((c) => c.path === 'drafts/preview' && c.body.id === draftId).length, 1);
      assert.equal(previewGets.get(saved), 1);
      assert.equal(await page.locator('#preview-loading-status').textContent(), '');
      assert.equal(await page.locator('.preview-spinner').count(), 0);
      assert.equal(await page.locator(draft).evaluate((el) => el === document.activeElement), true);
      assert.equal(await page.locator('[aria-busy=true]').count(), 0);
      await page.locator(draft).click();
      assert.equal(calls.filter((c) => c.path === 'drafts/preview' && c.body.id === draftId).length, 1);
    }, language),
  );
test('HI-02: obsolete failure cannot clear newer pending intent; timeout clears busy and permits explicit retry', () =>
  fixture(async ({ page, headDelay, accessDelay, failHeads, calls }) => {
    headDelay.set(previous, 650);
    failHeads.add(previous);
    await page.locator('[data-group-id=one] .show-version').click();
    await page.locator('#drafts-tab').click();
    accessDelay.set(draftId, 1400);
    const card = page.locator('[data-draft-id="' + draftId + '"]');
    await card.click();
    await page.waitForTimeout(800);
    assert.equal(await card.getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#notice').textContent(), '');
    await ready(page, 'saved', draftId, saved);
    // Use the production 10-second network deadline, not an injected shorter timer.
    accessDelay.set(draft2Id, 11000);
    const second = page.locator('[data-draft-id="' + draft2Id + '"]');
    await second.click();
    await page.waitForFunction(
      () => document.getElementById('notice').textContent.includes('Náhled se nepodařilo'),
      null,
      { timeout: 13000 },
    );
    await ready(page, 'saved', draftId, saved);
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    assert.equal(await card.locator('svg').getAttribute('data-selection-icon'), 'selected');
    assert.equal(await second.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.preview-pending').count(), 0);
    assert.equal(await page.locator('#preview-frame').getAttribute('aria-busy'), null);
    accessDelay.delete(draft2Id);
    await second.click();
    await ready(page, 'saved', draft2Id, saved2);
    assert.equal(calls.filter((c) => c.path === 'drafts/preview' && c.body.id === draft2Id).length, 2);
    await page.waitForTimeout(1200);
    await ready(page, 'saved', draft2Id, saved2);
  }));
