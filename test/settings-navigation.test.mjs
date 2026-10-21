import { test } from 'node:test';
import { sessionCookie } from '../apps/shell/session-cookie.mjs';
import assert from 'node:assert/strict';
import { launchBrowser, studioFrame } from './support/browser.mjs';
import { isolatedStack } from './support/stack.mjs';
import { settingsReturnTo } from '../apps/shell/settings-return.mjs';
test('SH-03: settings return only to normalized Editor or Studio internal paths', () => {
  for (const value of ['/site/', '/content/items?list=pages#row', '/content/structure?tab=fields', '/site/?mode=draft'])
    assert.equal(settingsReturnTo(value), value);
  for (const value of [
    null,
    'https://example.com',
    '//example.com/site/',
    '/site/../../login',
    '/site/%2e%2e/%2e%2e/login',
    '/site/\\example.com',
    '/site/%5cfoo',
    '/site/%0d%0aLocation:x',
    '/site/%',
    '/other',
    '/siteevil/',
  ])
    assert.equal(settingsReturnTo(value), '/content/');
});
test(
  'SH-03: shared settings return GET, the studio buttons, successful Save and reject hostile POST; Studio shows safe loading UI before state',
  { timeout: 240000 },
  async () => {
    const stack = await isolatedStack();
    let browser;
    try {
      const login = await fetch(stack.origin + '/login', {
          method: 'POST',
          headers: { Origin: stack.origin },
          body: new URLSearchParams({ password: stack.password }),
          redirect: 'manual',
        }),
        cookie = login.headers.get('set-cookie').split(';')[0],
        headers = { Cookie: cookie, Origin: stack.origin };
      for (const destination of ['/site/?mode=draft', '/content/?list=pages', 'https://example.com']) {
        const safe = settingsReturnTo(destination),
          response = await fetch(stack.origin + '/settings?returnTo=' + encodeURIComponent(destination), { headers }),
          html = await response.text();
        assert.match(html, new RegExp('name="returnTo" value="' + safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
        assert.ok(
          html.includes('class="shell-back" href="' + safe + '">') &&
            html.includes('>Editor obsahu</a>') &&
            html.includes('>AI Studio</a>'),
        );
        const revision = html.match(/name="revision" value="([^"]+)"/)[1];
        const saved = await fetch(stack.origin + '/settings', {
          method: 'POST',
          headers,
          body: new URLSearchParams({ returnTo: destination, revision, name: 'Fixture', theme: 'green' }),
          redirect: 'manual',
        });
        assert.equal(saved.status, 200);
        assert.ok((await saved.text()).includes('class="shell-back" href="' + safe + '"'));
      }
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page
        .context()
        .addCookies([{ name: sessionCookie(stack.origin), value: cookie.split('=')[1], url: stack.origin }]);
      let release;
      const held = new Promise((r) => (release = r));
      await page.route('**/site/api/state', async (route) => {
        await held;
        await route.continue();
      });
      await page.route('**/site/api/design-content-status', (route) => route.fulfill({ json: { unpublished: true } }));
      // Available models: AI Studio does not lead to the AI models screen by itself.
      await page.route('**/site/api/models', (route) =>
        route.fulfill({ json: { models: [], issues: [], optionalIssues: [] } }),
      );
      await page.goto(stack.origin + '/site/?origin=test', { waitUntil: 'domcontentloaded' });
      let ai = await studioFrame(page, 'site');
      await ai.locator('#workspace').waitFor({ state: 'visible' });
      assert.equal(await ai.locator('#workspace').getAttribute('aria-busy'), 'true');
      assert.equal(await ai.locator('#prompt-form').evaluate((n) => n.inert), true);
      assert.equal(await ai.locator('#run').isDisabled(), true);
      assert.match(
        await ai.locator('#shared-settings-link').getAttribute('href'),
        /returnTo=%2Fsite%2F%3Forigin%3Dtest/,
      );
      release();
      await ai.waitForFunction(() => !document.getElementById('workspace')?.hasAttribute('aria-busy'));
      assert.equal(await ai.locator('#cms-preview-source').inputValue(), 'unpublished');
      assert.equal(await ai.locator('#prompt-form').evaluate((n) => n.inert), false);
      assert.equal(await ai.locator('#workspace').getAttribute('aria-busy'), null);
      for (const source of ['/content/', '/site/?origin=test', '/content/structure?tab=fields']) {
        for (const action of ['back', 'save']) {
          await page.goto(stack.origin + source, { waitUntil: 'domcontentloaded' });
          if (source.startsWith('/site/')) {
            ai = await studioFrame(page, 'site');
            await ai.waitForFunction(() => !document.getElementById('workspace')?.hasAttribute('aria-busy'));
            await ai.locator('#studio-switcher summary').click();
            await ai.locator('#shared-settings-link').click();
          } else if (source.includes('/structure')) {
            await page.goto(stack.origin + '/settings?returnTo=' + encodeURIComponent(source));
          } else {
            const cm = await studioFrame(page, 'content');
            await cm.locator('.studio-switcher summary').click();
            await cm.locator('#shared-settings-link').click();
          }
          await page.waitForURL('**/settings?**');
          assert.equal(await page.locator('input[name=returnTo]').inputValue(), source);
          // Save only saves (the screen stays open); the button of the studio the user came from returns there.
          if (action === 'save') {
            await page.getByRole('button', { name: 'Uložit', exact: true }).click();
            await page.getByText('Uloženo', { exact: true }).waitFor();
          }
          await page
            .getByRole('link', { name: source.startsWith('/site/') ? 'AI Studio' : 'Editor obsahu', exact: true })
            .click();
          await page.waitForURL(stack.origin + source);
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      await stack.close();
    }
  },
);
