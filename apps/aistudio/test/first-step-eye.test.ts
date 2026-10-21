import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { studioPage } from './fixtures/studio-page.ts';
test('HI-10: the first step "Published version N" that starts the rebuilt draft has its eye, no progress, and is highlighted with its version', async () => {
  const browser = await chromium.launch({
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  // After publishing with "Remove previous steps" the draft is rebuilt from the version: the first step's commit is
  // also its base.
  const published = 'e'.repeat(40);
  const state = {
    head: published,
    presentationHead: published,
    publishedCommit: published,
    releases: [
      { id: 'release-5', number: 5, commit: published, description: 'Po úklidu', publishedAt: '2026-10-20T17:00:00Z' },
    ],
    history: [{ commit: published }],
    publishableCommits: [],
    requests: [
      {
        id: 'first',
        status: 'ready',
        commit: published,
        baseCommit: published,
        restoredFrom: published,
        firstStep: 'published',
        releaseId: 'release-5',
        releaseVersion: '5',
        releaseDescription: 'Po úklidu',
        presentationChanged: true,
        changeKind: 'version',
        prompt: '',
        sequence: 47,
      },
    ],
    savedDrafts: [],
  };
  const studio = await studioPage(browser, state);
  try {
    const page = studio.page,
      eye = page.locator('[data-group-id="first"] .show-version');
    assert.equal(await eye.count(), 1);
    // It stands for the version: a title and a preview, no "Show progress" of AI work it never had.
    assert.equal(await page.locator('[data-group-id="first"] .first-step-title').textContent(), 'Publikovaná verze 5 – Po úklidu');
    assert.equal(await page.locator('[data-group-id="first"] .progress-row, [data-group-id="first"] .response-text').count(), 0);
    await page.waitForFunction(
      () => document.querySelector('[data-group-id="first"] .show-version')?.getAttribute('aria-pressed') === 'true',
    );
    // Shown as the version, the first step stays highlighted with it.
    await page.locator('#history-toggle').click();
    await page.locator('[data-release-id="release-5"]').click();
    await page.waitForFunction(
      () => (document.getElementById('preview') as HTMLElement)?.dataset.commit === 'e'.repeat(40),
    );
    await page.locator('#edits-tab').click();
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(studio.errors, []);
  } finally {
    await studio.close();
    await browser.close();
  }
});
