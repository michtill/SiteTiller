import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { studioPage } from './fixtures/studio-page.ts';
test('AI-14: chat archives discussion above result, preserves expansion and leaves new discussion visible', async () => {
  const browser = await chromium.launch({
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  const sha = 'a'.repeat(40),
    requests: any[] = [];
  const req = (id: string, status: string, commit: string | null = null) => ({
    id,
    status,
    commit,
    prompt: id,
    sequence: requests.length + 1,
    progress: [
      { stage: 'request', message: id },
      {
        stage: status === 'running' ? 'build' : 'answer',
        status: status === 'running' ? 'running' : 'completed',
        message: 'Reply ' + id,
      },
      ...(status === 'running' ? [] : [{ stage: 'ready', commit }]),
    ],
  });
  requests.push(
    req('question1', 'answered'),
    req('question2', 'answered'),
    req('result', 'ready', sha),
    req('new-discussion', 'answered'),
  );
  const state = {
    head: sha,
    presentationHead: sha,
    releases: [],
    history: [{ commit: sha }],
    requests,
    publishableCommits: [sha],
  };
  const studio = await studioPage(browser, state);
  try {
    const p = studio.page;
    assert.equal(await p.locator('.discussion-archive').count(), 1);
    assert.equal(await p.locator('.discussion-archive .progress-group').count(), 2);
    assert.equal(await p.locator('#timeline .result-complete').count(), 1);
    assert.equal(await p.locator('#timeline .show-version').count(), 1);
    assert.equal(await p.locator('#timeline > .progress-group').count(), 2);
    await p.locator('.discussion-archive > summary').click();
    // A new state (another finished reply) re-renders the conversation; the opened archive stays open.
    await studio.update({ ...state, requests: [...requests, req('another', 'answered')] });
    assert.equal(await p.locator('.discussion-archive').getAttribute('open'), '');
    assert.equal(await p.locator('[data-group-id="new-discussion"]').isVisible(), true);
    assert.equal(await p.locator('[data-group-id="another"]').isVisible(), true);
    assert.deepEqual(studio.errors, []);
  } finally {
    await studio.close();
    await browser.close();
  }
});
