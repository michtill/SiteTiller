import test from 'node:test';
import { sessionCookie } from '../apps/shell/session-cookie.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, studioFrame } from './support/browser.mjs';
import { isolatedStack } from './support/stack.mjs';
import { readJson, revision, validateShared } from '../packages/settings/index.mjs';
import { sharedLanguage, colourMode } from '../packages/settings/shared-ui.mjs';
import { renderPage } from '../apps/shell/pages.ts';
test('I18-01: shared cs/en validates without migration; HTML language overrides browser-local preference and preserves authored names', async () => {
  const old = { name: 'Přihlásit se', theme: 'green', siteUrl: '', adminEmail: 'admin@example.test' };
  assert.equal(sharedLanguage(old), 'cs');
  // A former environment colour reads as the Light colour mode, the former black one as Dark (documentation 2.4).
  assert.equal(colourMode(old), 'light');
  assert.equal(colourMode({ theme: 'black' }), 'dark');
  const saved = { ...old, theme: colourMode(old) };
  assert.equal(
    validateShared({ ...saved, language: 'en' }, { current: old, validateSiteUrl: (v) => v }).language,
    'en',
  );
  assert.throws(() => validateShared({ ...saved, language: 'xx' }, { current: old, validateSiteUrl: (v) => v }));
  assert.throws(() => validateShared({ ...old, language: 'en' }, { current: old }));
  assert.equal(old.language, undefined);
  const login = await renderPage('login', { action: '/login', error: '' }, { language: 'en', site: 'Přihlásit se' });
  assert.ok(login.includes('<h1>Přihlásit se</h1>'));
  assert.ok(login.includes('<button>Sign in</button>'));
  const escaped = await renderPage('home', {}, { language: 'en', site: '<b>__USER_NAME_0__</b>' });
  assert.ok(escaped.includes('&lt;b&gt;__USER_NAME_0__&lt;/b&gt;') && !escaped.includes('<b>__USER'));
});
test('SH-03: real shared settings use CM authority/CAS, return destination, shared language and AI menu route; blocked live default leaves shared settings untouched', async () => {
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
    const load = async () => {
      const r = await fetch(stack.origin + '/settings?returnTo=%2Fsite%2F', { headers });
      assert.equal(r.status, 200);
      return r.text();
    };
    let html = await load();
    assert.match(html, /Výchozí režim editace obsahu/);
    assert.ok(!html.includes('Nastavení Editoru obsahu jsou'));
    const fields = (text) => ({
      revision: text.match(/name="revision" value="([^"]+)"/)[1],
    });
    const beforePublic = await readFile(join(stack.root, '.production/current.json'), 'utf8');
    let r = await fetch(stack.origin + '/settings', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        ...fields(html),
        returnTo: '/site/',
        name: 'Fixture',
        theme: 'dark',
        language: 'en',
        contentDefault: 'live',
      }),
      redirect: 'manual',
    });
    assert.equal(r.status, 200);
    // Save only saves: the screen stays open and the studio button still leads where the user came from.
    assert.ok((await r.text()).includes('class="shell-back" href="/site/"'));
    const cmOrigin = 'http://127.0.0.1:' + stack.ports.cmstudio;
    assert.equal((await readJson(join(stack.root, 'settings/shared.json'))).contentDefault, 'live');
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), beforePublic);
    // AI Studio follows the colour mode.
    assert.match(await (await fetch(stack.origin + '/site/', { headers })).text(), /data-mode="dark"/);
    html = await load();
    assert.match(html, /Default content editing mode/);
    assert.match(html, /<html lang="en"[\s>]/);
    assert.match(html, /Default colour mode/);
    assert.doesNotMatch(html, /aiStudioDayNight/);
    r = await fetch(stack.origin + '/settings', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        ...fields(html),
        returnTo: '/site/',
        name: 'Fixture',
        theme: 'dark',
        language: 'en',
        contentDefault: 'draft',
      }),
      redirect: 'manual',
    });
    assert.equal(r.status, 200);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page
      .context()
      .addCookies([{ name: sessionCookie(stack.origin), value: cookie.split('=')[1], url: stack.origin }]);
    await page.route('**/site/api/models', (route) =>
      route.fulfill({ json: { models: [], issues: [], optionalIssues: [] } }),
    );
    // AI models are a settings screen of the Shell, in the shared language.
    await page.goto(stack.origin + '/settings/aiapi?returnTo=%2Fsite%2F');
    const settings = await studioFrame(page, 'settings');
    assert.equal(await settings.locator('html').getAttribute('lang'), 'en');
    assert.equal(await settings.locator('h1').textContent(), 'AI Studio models');
    await settings.getByRole('link', { name: 'AI Studio', exact: true }).click();
    const ai = await studioFrame(page, 'site');
    assert.equal(await ai.locator('html').getAttribute('data-shared-language'), 'en');
    await ai.locator('#studio-switcher summary').click();
    assert.deepEqual(await ai.locator('#studio-switcher nav>:is(a,button)').allTextContents(), ['Settings', 'Log out']);
    assert.deepEqual(
      await ai.locator('.studio-toggle a').evaluateAll((a) => a.map((e) => e.getAttribute('aria-label'))),
      ['Content editor', 'AI Studio'],
    );
    assert.equal(await ai.locator('#shared-settings-link').getAttribute('href'), '/settings?returnTo=%2Fsite%2F');
    await page.goto(stack.origin + '/content/');
    const cm = await studioFrame(page, 'content');
    await cm.locator('.studio-switcher summary').click();
    assert.deepEqual(await cm.locator('.studio-switcher nav>:is(a,button)').allTextContents(), ['Settings', 'Log out']);
    const content = await (await fetch(stack.origin + '/content/', { headers })).text();
    assert.match(content, /data-shared-language="en"/);
    assert.match(content, /lang="en"/);
    const schema = await readJson(join(stack.root, 'schema/structure.json')),
      name = Object.keys(schema.lists)[0],
      rows = await readJson(join(stack.root, 'data', name + '.json')),
      column = Object.keys(schema.lists[name].columns).find(
        (k) => k !== schema.lists[name].key && schema.lists[name].columns[k].type === 'text',
      );
    assert.ok(rows.length && column);
    rows[0][column] += ' changed in fixture';
    await writeFile(join(stack.root, 'data', name + '.json'), JSON.stringify(rows));
    html = await load();
    const sharedBefore = await readFile(join(stack.root, 'settings/shared.json'), 'utf8');
    r = await fetch(stack.origin + '/settings', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        ...fields(html),
        returnTo: '/site/',
        name: 'Saved default',
        theme: 'light',
        language: 'cs',
        contentDefault: 'live',
      }),
      redirect: 'manual',
    });
    // The default is only a setting: it saves even with unpublished changes and does not switch the open Editor.
    assert.equal(r.status, 200);
    assert.notEqual(await readFile(join(stack.root, 'settings/shared.json'), 'utf8'), sharedBefore);
    assert.equal((await readJson(join(stack.root, 'settings/shared.json'))).contentDefault, 'live');
    assert.equal((await (await fetch(cmOrigin + '/api/edit-mode')).json()).autoPublish, false);
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), beforePublic);
  } finally {
    await browser?.close();
    await stack.close();
  }
});
test(
  'SH-03: after Save the side band shows the new website name at once, in plain letters',
  { timeout: 120000 },
  async () => {
    const stack = await isolatedStack();
    try {
      const login = await fetch(stack.origin + '/login', {
          method: 'POST',
          headers: { Origin: stack.origin },
          body: new URLSearchParams({ password: stack.password }),
          redirect: 'manual',
        }),
        headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: stack.origin };
      const form = await (await fetch(stack.origin + '/settings', { headers })).text();
      // Operation: unused parts sleep after 15 minutes by default (documentation 2.4).
      assert.match(form, /<option value="15" selected>Po 15 minutách<\/option>/);
      const saved = await (
        await fetch(stack.origin + '/settings', {
          method: 'POST',
          headers,
          body: new URLSearchParams({
            revision: form.match(/name="revision" value="([^"]+)"/)[1],
            returnTo: '/site/',
            name: 'Nový název webu',
            theme: 'light',
            language: 'cs',
            contentDefault: 'draft',
            sleepMinutes: '0',
          }),
        })
      ).text();
      assert.equal(JSON.parse(await readFile(join(stack.root, 'settings/shared.json'), 'utf8')).sleepMinutes, 0);
      assert.match(saved, /<option value="0" selected>Nikdy<\/option>/);
      // The header of Settings is the studios' header: the name in plain letters, in the header's own colour.
      assert.match(saved, /<span class="studio-switcher-name">Nový název webu<\/span><small>Nastavení<\/small>/);
      assert.match(saved, /\.studio-logo small \{[^}]*color: inherit/);
    } finally {
      await stack.close();
    }
  },
);
test('SH-03: every page of the application carries the SiteTiller icon and the tab title "SiteTiller · <website name>"', async () => {
  const stack = await isolatedStack();
  try {
    // The icon files are public: the sign-in page shows them too.
    for (const [path, type] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon-32.png', 'image/png'],
      ['/apple-touch-icon.png', 'image/png'],
      ['/favicon.ico', 'image/x-icon'],
    ]) {
      const r = await fetch(stack.origin + path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('content-type'), type);
      assert.ok((await r.arrayBuffer()).byteLength > 100, path);
    }
    const name = JSON.parse(await readFile(join(stack.root, 'settings/shared.json'), 'utf8')).name;
    const icon = /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/;
    const loginPage = await (await fetch(stack.origin + '/login')).text();
    assert.match(loginPage, icon);
    assert.ok(loginPage.includes('<title>SiteTiller · ' + name + '</title>'));
    const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    // Settings, and the frame page of a studio (the tab of a studio), have the same title and icon.
    const settings = await (await fetch(stack.origin + '/settings', { headers })).text();
    assert.match(settings, icon);
    assert.ok(settings.includes('<title>SiteTiller · ' + name + '</title>'));
    const frame = await (
      await fetch(stack.origin + '/content/', { headers: { ...headers, 'Sec-Fetch-Dest': 'document' } })
    ).text();
    assert.match(frame, icon);
    assert.ok(frame.includes('<title>SiteTiller · ' + name + '</title>'));
  } finally {
    await stack.close();
  }
});
