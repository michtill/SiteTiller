import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { studioPage } from './fixtures/studio-page.ts';
test('CO-01: legacy current ready presentation missing history/classification has a working eye after older/published/saved preview; content-only steps have none', async () => {
  const browser = await chromium.launch({
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  const head = '8dac99c2518594733586f3957f1d5b24bef6b34d',
    old = '4a1fd46d9bc87200e44fad1f7e57cd31b4db3728',
    published = '6e3ec93cdd87e5b2626186378e26c310d701cc38',
    content = 'c'.repeat(40),
    saved = 'd'.repeat(40);
  const state = {
    head,
    presentationHead: head,
    releases: [{ id: 'release-1', number: 1, commit: published, publishedAt: '2026-10-11T12:00:00Z' }],
    history: [{ commit: published }],
    publishableCommits: [head],
    requests: [
      { id: 'older', status: 'ready', commit: old, baseCommit: 'a'.repeat(40), prompt: 'Older', sequence: 1 },
      {
        id: '74f2d632340965a8',
        status: 'ready',
        commit: head,
        baseCommit: old,
        prompt: 'Zahoď.',
        sequence: 2,
        progress: [
          { stage: 'request', message: 'Zahoď.' },
          { stage: 'build', status: 'completed', message: 'Removed footer link' },
          { stage: 'ready', commit: head, baseCommit: old },
        ],
      },
      {
        id: 'content',
        status: 'ready',
        commit: content,
        baseCommit: head,
        presentationChanged: false,
        changeKind: 'content',
        prompt: 'Content only',
        sequence: 3,
      },
    ],
    savedDrafts: [{ id: 'saved', commit: saved, name: 'Saved', createdAt: '2026-10-11T12:00:00Z' }],
  };
  const studio = await studioPage(browser, state);
  try {
    const page = studio.page,
      currentEye = page.locator('[data-group-id="74f2d632340965a8"] .show-version');
    const shows = async (commit: string) =>
      page.waitForFunction(
        (commit) => (document.getElementById('preview') as HTMLElement)?.dataset.commit === commit,
        commit,
      );
    const pressed = (value: string) =>
      page.waitForFunction(
        (value) =>
          document.querySelector('[data-group-id="74f2d632340965a8"] .show-version')?.getAttribute('aria-pressed') ===
          value,
        value,
      );
    assert.equal(await currentEye.count(), 1);
    await pressed('true');
    assert.equal(await page.locator('[data-group-id="content"] .show-version').count(), 0);
    await page.locator('[data-group-id="older"] .show-version').click();
    await shows(old);
    await pressed('false');
    await currentEye.click();
    await shows(head);
    await pressed('true');
    for (const [tab, card, commit] of [
      ['#history-toggle', '[data-release-id="release-1"]', published],
      ['#drafts-tab', '[data-draft-id="saved"]', saved],
    ]) {
      await page.locator(tab).click();
      await page.locator(card).click();
      await shows(commit);
      await pressed('false');
      await page.locator('#edits-tab').click();
      await currentEye.click();
      await shows(head);
      await pressed('true');
      assert.equal(await page.locator('.release-actions').getAttribute('data-kind'), 'step');
    }
    // The current step becomes content-only: it gets no eye of its own and the last presentation stays shown.
    await studio.update({ ...state, head: content });
    assert.equal(await page.locator('[data-group-id="content"] .show-version').count(), 0);
    await pressed('true');
    assert.deepEqual(studio.errors, []);
  } finally {
    await studio.close();
    await browser.close();
  }
});
