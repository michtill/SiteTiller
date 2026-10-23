import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser } from './support/browser.mjs';
// A saved draft's private preview link (documentation 2.8) shows the page with its styles: the page needs the
// sign-in, the files it loads come with the draft's own short-lived key.
test(
  'MC-08: the private link to a saved draft opens after signing in with its styles; without the sign-in only its files load',
  { timeout: 180000 },
  async () => {
    const stack = await isolatedStack({});
    let browser;
    try {
      const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const form = (values) =>
        fetch(stack.origin + '/settings/mcp', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: stack.origin },
          body: new URLSearchParams(values),
        });
      await form({ action: 'save', enabled: 'on', edit: 'on' });
      const token = (await (await form({ action: 'token', tokenName: 'Claude' })).text()).match(
        /value="(st_[a-f0-9]{64})"/,
      )[1];
      const call = async (name, args = {}) => {
        const response = await fetch(stack.origin + '/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        const result = (await response.json()).result;
        assert.equal(result.isError, false, JSON.stringify(result));
        return result.structuredContent;
      };
      await call('write_site_files', {
        summary: 'Stránka se stylem',
        files: [
          {
            path: 'site/styl.html',
            text: '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Styl</title><link rel="stylesheet" href="style.css"></head><body><h1>Styl</h1></body></html>',
          },
          { path: 'site/style.css', text: 'h1{color:rgb(255, 0, 0)}' },
        ],
      });
      const saved = await call('save_draft', { name: 'Se stylem', clear_previous: false }),
        link = (await call('preview_link', { saved_draft_id: saved.id })).url;
      // Without the sign-in: the page asks for it, a file of the page loads with the draft's key.
      assert.equal((await fetch(link + 'styl.html', { redirect: 'manual' })).status, 303);
      assert.equal(
        (await fetch(link + 'styl.html', { redirect: 'manual', headers: { 'Sec-Fetch-Dest': 'document' } })).status,
        303,
      );
      assert.equal((await fetch(link + 'style.css', { redirect: 'manual' })).status, 303);
      assert.equal((await fetch(link + 'style.css', { headers: { 'Sec-Fetch-Dest': 'style' } })).status, 200);
      const forged = link.replace(/[a-f0-9]{64}\/$/, 'f'.repeat(64) + '/');
      assert.equal((await fetch(forged + 'style.css', { headers: { 'Sec-Fetch-Dest': 'style' } })).status, 401);
      // In the browser after signing in: the page with its styles.
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto(stack.origin + '/login');
      await page.locator('input[name=password]').fill(stack.password);
      await page.locator('button:not(.show-password)').click();
      await page.waitForURL((url) => url.pathname === '/');
      await page.goto(link + 'styl.html');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).color === 'rgb(255, 0, 0)');
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
