import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { studioPage } from './fixtures/studio-page.ts';
test('AI-11: composer choices persist between requests in page but reset after reload', async () => {
  const browser = await chromium.launch({
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
    headless: true,
  });
  const head = 'a'.repeat(40),
    studio = await studioPage(browser, { head, presentationHead: head, history: [{ commit: head }] });
  try {
    const page = studio.page;
    await page.locator('#request-options summary').click();
    await page.locator('#simple-change').click();
    assert.equal(await page.locator('#request-technical').isChecked(), false);
    assert.equal(await page.locator('#request-verification').isChecked(), false);
    assert.equal(await page.locator('#request-options').getAttribute('open'), null);
    await page.locator('#prompt').fill('Test');
    await page.locator('#run').click();
    await page.waitForFunction(() => (document.getElementById('prompt') as HTMLTextAreaElement).value === '');
    assert.deepEqual(studio.calls.find((c) => c.path === 'run')?.body.checks, {
      technical: false,
      verification: false,
    });
    assert.equal(await page.locator('#request-technical').isChecked(), false);
    await page.locator('#request-options summary').click();
    await page.locator('#request-verification').check();
    assert.equal(await page.locator('#request-technical').isChecked(), false);
    assert.equal(await page.locator('#request-options-label').textContent(), 'Vlastní postup');
    await page.locator('#request-options summary').press('Escape');
    assert.equal(await page.locator('#request-options').getAttribute('open'), null);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('workspace')?.hasAttribute('aria-busy'));
    assert.equal(await page.locator('#request-technical').isChecked(), true);
    assert.equal(await page.locator('#request-verification').isChecked(), true);
    assert.equal(await page.locator('#request-options-label').textContent(), 'Standardní postup');
    assert.deepEqual(studio.errors, []);
  } finally {
    await studio.close();
    await browser.close();
  }
});
