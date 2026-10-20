import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../apps/shell/pages.ts';
import { launchBrowser } from './support/browser.mjs';
test('SH-11: every password field can be shown and hidden again; without scripts the button is not there', async () => {
  const pages = [
    await renderPage('login', { action: '/login', error: '' }),
    await renderPage('password', { error: '' }, { language: 'en' }),
  ];
  // Without scripts the button stays hidden and the field is a plain password input.
  for (const html of pages) assert.match(html, /<button type="button" class="show-password" hidden aria-pressed="false"/);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    for (const [html, fields, show, hide] of [
      [pages[0], 1, 'Zobrazit', 'Skrýt'],
      [pages[1], 3, 'Show', 'Hide'],
    ]) {
      await page.setContent(html);
      const buttons = page.locator('.show-password');
      assert.equal(await buttons.count(), fields);
      const input = page.locator('.password-field input').first();
      await input.fill('secret-123');
      assert.equal(await buttons.first().getAttribute('aria-label'), show);
      await buttons.first().click();
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(await buttons.first().getAttribute('aria-label'), hide);
      assert.equal(await input.inputValue(), 'secret-123');
      await buttons.first().click();
      assert.equal(await input.getAttribute('type'), 'password');
      assert.equal(await buttons.first().getAttribute('aria-label'), show);
    }
  } finally {
    await browser.close();
  }
});
