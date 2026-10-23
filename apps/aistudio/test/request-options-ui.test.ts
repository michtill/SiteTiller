import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { studioPage } from './fixtures/studio-page.ts';
// One choice for the request (documentation 4.2): the team, and under it the two checks.
test('AI-11: composer choices persist between requests in page but reset after reload', async () => {
  const browser = await chromium.launch({
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  const head = 'a'.repeat(40),
    studio = await studioPage(browser, { head, presentationHead: head, history: [{ commit: head }] });
  try {
    const page = studio.page;
    // No workflow choice of its own any more.
    assert.equal(await page.locator('#request-options').count(), 0);
    await page.locator('#team-choice summary').click();
    await page.locator('#request-technical').uncheck();
    await page.locator('#request-verification').uncheck();
    await page.locator('#team-choice summary').press('Escape');
    assert.equal(await page.locator('#team-choice').getAttribute('open'), null);
    await page.locator('#prompt').fill('Test');
    await page.locator('#run').click();
    await page.waitForFunction(() => (document.getElementById('prompt') as HTMLTextAreaElement).value === '');
    assert.deepEqual(studio.calls.find((c) => c.path === 'run')?.body.checks, {
      technical: false,
      verification: false,
    });
    assert.equal(await page.locator('#request-technical').isChecked(), false);
    await page.locator('#team-choice summary').click();
    await page.locator('#request-verification').check();
    assert.equal(await page.locator('#request-technical').isChecked(), false);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('workspace')?.hasAttribute('aria-busy'));
    assert.equal(await page.locator('#request-technical').isChecked(), true);
    assert.equal(await page.locator('#request-verification').isChecked(), true);
    assert.deepEqual(studio.errors, []);
  } finally {
    await studio.close();
    await browser.close();
  }
});
