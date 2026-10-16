import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { Store } from './store.ts';
import { Publication } from './publication.ts';
import { restoreRevision } from './design-restore.ts';
for (const language of ['cs', 'en'])
  test('SH-07: shared ' + language + ' UI/menu/dirty navigation/default setting authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cm-shared-ui-'));
    let child, browser;
    try {
      for (const dir of ['schema', 'data', 'media', 'settings']) await mkdir(join(root, dir));
      const schema = {
        version: 1,
        folders: {},
        lists: {
          items: {
            label: 'Moje kolekce',
            key: 'id',
            display: 'title',
            columns: {
              id: { label: 'Identifikátor', type: 'text', required: true },
              title: { label: 'Uživatelský název', type: 'text', required: true },
            },
          },
        },
      };
      await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
      await writeFile(
        join(root, 'data/items.json'),
        '[{"id":"one","title":"Původní obsah"},{"id":"two","title":"Druhý obsah"}]',
      );
      const shared = JSON.stringify({ name: 'Uživatelský web', theme: 'green', language });
      await writeFile(join(root, 'settings/shared.json'), shared);
      const store = new Store(root),
        publication = new Publication(root, store, join(root, '.production'));
      await publication.publish(undefined, await restoreRevision(root));
      const listener = createServer();
      await new Promise((r) => listener.listen(0, '127.0.0.1', r));
      const port = listener.address().port;
      await new Promise((r) => listener.close(r));
      const origin = 'http://127.0.0.1:' + port;
      child = spawn(process.execPath, ['server/server.ts'], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          PORT: String(port),
          SITETILLER_INSTANCE_ROOT: root,
          CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
          SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
          SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      let boot;
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(origin + '/api/bootstrap');
          if (response.ok) {
            boot = await response.json();
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(boot, 'isolated CM became ready');
      const headers = { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/json' };
      const call = async (path, body, method = 'POST') =>
        fetch(origin + path, { method, headers, body: JSON.stringify(body) });
      const revisionBefore = await restoreRevision(root),
        publishedBefore = await readFile(join(root, '.cms-publication/current.json'), 'utf8');
      assert.equal((await call('/api/edit-mode', { autoPublish: false })).status, 200);
      // A new default in the Shared settings applies after a restart; the running Editor keeps its mode.
      await writeFile(
        join(root, 'settings/shared.json'),
        JSON.stringify({ ...JSON.parse(shared), contentDefault: 'live' }),
      );
      assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, false);
      await writeFile(join(root, 'settings/shared.json'), shared);
      assert.equal(await restoreRevision(root), revisionBefore);
      assert.equal(await readFile(join(root, '.cms-publication/current.json'), 'utf8'), publishedBefore);
      assert.equal((await fetch(origin + '/api/settings')).status, 404);
      browser = await chromium.launch({
        ...(process.env.SITETILLER_BROWSER_EXECUTABLE
          ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
          : {}),
        headless: true,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      const failures = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await page.addInitScript(
        (value) => {
          localStorage.setItem('sitetiller-language', value);
          localStorage.setItem('sitetiller-ui-language', value);
        },
        language === 'cs' ? 'en' : 'cs',
      );
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.continue();
        if (url.pathname.startsWith('/content/')) {
          const response = await route.fetch({ url: origin + url.pathname.slice('/content'.length) + url.search });
          if ((response.headers()['content-type'] || '').includes('text/html')) {
            const html = (await response.text())
              .replace(/<html[^>]*>/, '<html lang="' + language + '" data-shared-language="' + language + '">')
              .replace('<head>', '<head><meta name="app-base" content="/content"><base href="/content/">');
            return route.fulfill({ response, body: html });
          }
          return route.fulfill({ response });
        }
        if (['/site/', '/settings', '/logout'].includes(url.pathname))
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body>fixture destination</body></html>',
          });
        return route.continue();
      });
      const text =
        language === 'en'
          ? {
              menu: ['Content editor', 'AI Studio', 'Common settings', 'AI models', 'Log out'],
              dialog: 'Unsaved changes',
              save: 'Save',
              discard: 'Discard edits',
              cancel: 'Cancel',
              structure: 'Structure editor',
              fieldType: 'Field type',
              single: 'Single-line text',
              label: 'Label',
              collection: 'Collection name',
              pattern: 'Pattern (regular expression)',
              error: 'already exists',
              target: '/site/?settings=ai',
            }
          : {
              menu: ['Editor obsahu', 'AI Studio', 'Společné nastavení', 'AI modely', 'Odhlásit'],
              dialog: 'Neuložené úpravy',
              save: 'Uložit',
              discard: 'Zahodit úpravy',
              cancel: 'Storno',
              structure: 'Editor struktury',
              fieldType: 'Typ pole',
              single: 'Jednořádkový text',
              label: 'Popisek',
              collection: 'Název kolekce',
              pattern: 'Pattern (regulární výraz)',
              error: 'již existuje',
              target: '/site/?settings=ai',
            };
      const menu = page.locator('.studio-switcher'),
        openMenu = () => menu.locator('summary').click();
      await page.goto(origin + '/content/');
      await page.getByRole('textbox', { name: 'Uživatelský název', exact: true }).waitFor();
      assert.equal(await page.locator('html').getAttribute('data-shared-language'), language);
      await openMenu();
      assert.deepEqual(await menu.locator('nav>:is(a,button)').allTextContents(), text.menu);
      await openMenu();
      assert.equal(await page.locator('.studio-brand-actions,.cms-settings-entry,.cms-settings-overlay').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Moje kolekce', exact: false }).count(), 1);
      assert.equal(await page.getByRole('heading', { name: 'Původní obsah', exact: true }).count(), 1);
      const title = page.getByRole('textbox', { name: 'Uživatelský název', exact: true }),
        id = page.getByRole('textbox', { name: 'Identifikátor', exact: true }),
        dialog = page.getByRole('dialog', { name: text.dialog });
      await title.fill('Rozepsaný obsah');
      await openMenu();
      await menu.getByRole('link', { name: text.menu[3], exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: text.save, exact: true }).count(), 1);
      await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
      assert.equal(await title.inputValue(), 'Rozepsaný obsah');
      assert.equal(new URL(page.url()).pathname, '/content/');
      await id.fill('two');
      await openMenu();
      await menu.getByRole('link', { name: text.menu[3], exact: true }).click();
      await dialog.getByRole('button', { name: text.save, exact: true }).click();
      const error = page.getByRole('status').filter({ hasText: text.error });
      await error.waitFor();
      assert.match(await error.textContent(), /Identifikátor/);
      assert.equal(await title.inputValue(), 'Rozepsaný obsah');
      assert.equal(new URL(page.url()).pathname, '/content/');
      await id.fill('one');
      await openMenu();
      await menu.getByRole('link', { name: text.menu[3], exact: true }).click();
      await dialog.getByRole('button', { name: text.save, exact: true }).click();
      await page.waitForURL(origin + text.target);
      assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].title, 'Rozepsaný obsah');
      await page.goto(origin + '/content/');
      await title.fill('Neuložené odhlášení');
      await openMenu();
      await menu.getByRole('button', { name: text.menu[4], exact: true }).click();
      await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
      assert.equal(await title.inputValue(), 'Neuložené odhlášení');
      await openMenu();
      await menu.getByRole('button', { name: text.menu[4], exact: true }).click();
      await dialog.getByRole('button', { name: text.discard, exact: true }).click();
      await page.waitForURL(origin + '/logout');
      assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].title, 'Rozepsaný obsah');
      await page.goto(origin + '/content/?view=current');
      await title.waitFor();
      await openMenu();
      await menu.getByRole('link', { name: text.menu[2], exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/settings');
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), '/content/?view=current');
      await page.goto(origin + '/content/structure');
      await page.getByRole('heading', { name: text.structure, exact: true }).waitFor();
      assert.equal(await menu.count(), 0);
      const back = page.locator('.architect-back');
      assert.equal(await back.textContent(), '← ' + text.menu[0]);
      const field = page.locator('.field-definition').first();
      await field.locator('.field-toggle').click();
      assert.equal(await field.getByLabel(text.fieldType).locator('option[value="text"]').textContent(), text.single);
      const collection = page.getByLabel(text.collection, { exact: false });
      await collection.fill('Nový uživatelský název');
      await back.click();
      await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
      assert.equal(await collection.inputValue(), 'Nový uživatelský název');
      const pattern = field.getByLabel(text.pattern, { exact: false });
      await pattern.fill('[');
      await back.click();
      await dialog.getByRole('button', { name: text.save, exact: true }).click();
      await page
        .getByRole('status')
        .filter({ hasText: language === 'en' ? 'regular expression' : 'regulární výraz' })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, '/content/structure');
      await pattern.fill('[A-Za-z]+');
      await back.click();
      await dialog.getByRole('button', { name: text.save, exact: true }).click();
      await page.waitForURL(origin + '/content/');
      assert.equal(
        JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8')).lists.items.label,
        'Nový uživatelský název',
      );
      const defaultBefore = await restoreRevision(root);
      // With unpublished changes live editing cannot be switched on.
      assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 409);
      assert.equal(await restoreRevision(root), defaultBefore);
      assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, false);
      assert.deepEqual(failures, []);
    } finally {
      await browser?.close();
      if (child) {
        child.kill();
        await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      }
      await rm(root, { recursive: true, force: true });
    }
  });
