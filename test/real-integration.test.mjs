import { Project } from '../apps/aistudio/src/project.ts';
import { restoredContent, restoreContentState, applyRestoredContent } from '../apps/aistudio/src/restore-content.ts';
import { launchBrowser, studioFrame } from './support/browser.mjs';
let studio;
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { isolatedStack } from './support/stack.mjs';
import { readJson } from '../packages/settings/index.mjs';
import { contentBaseline, applyDesignContent } from '../apps/aistudio/src/cms-content-write.ts';
import { cmsSource } from '../apps/aistudio/src/cms-source.ts';

test(
  'IN-01: real CMStudio + AIStudio: one login, shared settings, content CAS, publication and live-editing isolation',
  { timeout: 120000 },
  async () => {
    assert.ok(
      existsSync('apps/cmstudio/server/server.ts'),
      'CMStudio module must be supplied before genuine integration',
    );
    assert.ok(
      existsSync('apps/cmstudio/dist/index.html'),
      'CMStudio build must be completed before genuine integration',
    );
    const stack = await isolatedStack();
    let browser;
    const { origin, root, website } = stack;
    try {
      browser = await launchBrowser();
      const context = await browser.newContext(),
        page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(30000);
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin + '/login');
      assert.match(await page.locator('h1').textContent(), /SiteTiller playground/);
      assert.doesNotMatch(await page.locator('body').textContent(), /LEGACY MUST NOT WIN/);
      await page.locator('input[name=password]').fill(stack.password);
      await page.locator('button:not(.show-password)').click();
      // Signed in, the home page; the Content editor from its card.
      await page.waitForURL((url) => url.pathname === '/');
      await page.goto(new URL('/content/', page.url()).href);
      studio = await studioFrame(page, 'content');
      await studio.getByRole('textbox', { name: 'Nadpis', exact: true }).waitFor();
      assert.equal(await studio.evaluate(() => document.baseURI), origin + '/content/');
      const cookies = await context.cookies(origin),
        cookie = cookies.map((c) => c.name + '=' + c.value).join('; '),
        headers = { Cookie: cookie, Origin: origin };
      async function api(path, method = 'GET', body, token) {
        const response = await fetch(origin + path, {
          method,
          headers: {
            ...headers,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { 'x-cms-token': token } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const value = await response.json();
        return { status: response.status, value };
      }
      const baseline = (await api('/content/api/bootstrap')).value;
      assert.equal(baseline.settings.name, 'SiteTiller playground');
      assert.equal(baseline.settings.theme, 'green');
      assert.equal(baseline.autoPublish, false);
      assert.equal(baseline.lists.pages.rows[0].title, 'SiteTiller playground');
      assert.equal((await api('/content/api/publication')).value.unpublished, false);
      await studio.getByRole('textbox', { name: 'Nadpis', exact: true }).fill('Genuine CM draft');
      await studio.getByRole('button', { name: 'Uložit úpravy', exact: true }).click();
      await studio.waitForFunction(async () => {
        const r = await fetch('api/bootstrap');
        return (await r.json()).lists.pages.rows[0].title === 'Genuine CM draft';
      });
      const after = (await api('/content/api/bootstrap')).value;
      assert.equal(after.lists.pages.rows[0].title, 'Genuine CM draft');
      assert.equal(
        (
          await api(
            '/content/api/lists/pages',
            'PUT',
            {
              rows: baseline.lists.pages.rows,
              revision: baseline.lists.pages.revision,
              schemaRevision: baseline.schemaRevision,
            },
            after.token,
          )
        ).status,
        409,
      );
      assert.equal((await api('/content/api/edit-mode', 'POST', { autoPublish: true }, after.token)).status, 409);
      const pointerBefore = await readFile(join(root, '.production/current.json'), 'utf8');
      assert.doesNotMatch(await (await fetch(website + '/')).text(), /Genuine CM draft/);
      // Offline there are no usable models; answering with none keeps AI Studio from leading to AI models.
      await page.route('**/site/api/models', (route) => route.fulfill({ json: { models: [], issues: [], optionalIssues: [] } }));
      await page.goto(origin + '/site/');
      studio = await studioFrame(page, 'site');
      await studio.locator('#workspace').waitFor({ state: 'visible' });
      await studio.waitForFunction(() => document.getElementById('preview').src.includes('/preview/access/'));
      await studio.frameLocator('#preview').getByRole('heading', { name: 'Genuine CM draft', exact: true }).waitFor();
      const state = (await api('/site/api/state')).value;
      assert.equal(state.editorName, 'SiteTiller playground');
      assert.equal(
        state.providers.some((p) => p.hasKey),
        false,
      );
      assert.match(await (await fetch(state.previewUrl + 'sources/unpublished/')).text(), /Genuine CM draft/);
      assert.doesNotMatch(await (await fetch(state.previewUrl + 'sources/published/')).text(), /Genuine CM draft/);
      const current = (await api('/content/api/publication')).value;
      assert.equal(current.unpublished, true);
      assert.equal(
        (
          await api(
            '/content/api/publication',
            'POST',
            { confirm: true, expectedRevision: '0'.repeat(64) },
            after.token,
          )
        ).status,
        409,
      );
      assert.equal(await readFile(join(root, '.production/current.json'), 'utf8'), pointerBefore);
      assert.equal(
        (
          await api(
            '/content/api/publication',
            'POST',
            { confirm: true, expectedRevision: (await api('/content/api/design-restore-state')).value.revision },
            after.token,
          )
        ).status,
        200,
      );
      assert.match(await (await fetch(website + '/')).text(), /Genuine CM draft/);
      assert.equal((await api('/content/api/publication')).value.unpublished, false);
      assert.equal((await api('/content/api/edit-mode', 'POST', { autoPublish: true }, after.token)).status, 200);
      // Exercise the real AI content adapter without any model call, including dry-run/live edit behavior.
      const oldRoot = process.env.SITETILLER_CMS_ROOT,
        oldUrl = process.env.SITETILLER_CMS_URL;
      process.env.SITETILLER_CMS_ROOT = root;
      process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
      try {
        const source = await cmsSource(root);
        source.context.readOnly = false;
        const base = await contentBaseline(source),
          files = { ...source.files };
        const rows = JSON.parse(files['site/cms/data/pages.json']);
        rows[0].title = 'AI adapter draft';
        files['site/cms/data/pages.json'] = JSON.stringify(rows);
        await applyDesignContent(base, files, true);
        assert.equal((await api('/content/api/edit-mode')).value.autoPublish, true);
        await applyDesignContent(base, files, false);
        assert.equal((await api('/content/api/edit-mode')).value.autoPublish, false);
        const publication = await readJson(join(root, '.production/current.json')),
          publishedSource = await cmsSource(join(publication.directory, 'cms'), true);
        assert.equal(await contentBaseline(publishedSource), null);
        assert.equal(await applyDesignContent(null, files, false), null);
        const project = new Project(join(root, '.sitetiller/project')),
          frozen = await restoredContent(project, await project.head()),
          restore = await restoreContentState();
        await applyRestoredContent(frozen, restore.revision, true);
        assert.equal((await readJson(join(root, 'data/pages.json')))[0].title, 'AI adapter draft');
        await assert.rejects(() => applyRestoredContent(frozen, '0'.repeat(64), false));
        assert.equal((await readJson(join(root, 'data/pages.json')))[0].title, 'AI adapter draft');
        await applyRestoredContent(frozen, restore.revision, false);
        assert.equal((await readJson(join(root, 'data/pages.json')))[0].title, 'SiteTiller playground');
        assert.equal(
          await readFile(join(root, 'media/files/fixture.txt'), 'utf8'),
          await readFile('fixtures/playground/fixture.txt', 'utf8'),
        );
        assert.match(await (await fetch(website + '/')).text(), /Genuine CM draft/);
      } finally {
        if (oldRoot === undefined) delete process.env.SITETILLER_CMS_ROOT;
        else process.env.SITETILLER_CMS_ROOT = oldRoot;
        if (oldUrl === undefined) delete process.env.SITETILLER_CMS_URL;
        else process.env.SITETILLER_CMS_URL = oldUrl;
      }
      assert.equal((await api('/content/api/edit-mode')).value.autoPublish, false);
      assert.match(await (await fetch(website + '/')).text(), /Genuine CM draft/);
      assert.doesNotMatch(await (await fetch(website + '/')).text(), /AI adapter draft/);
      await page.goto(origin + '/settings');
      await page.locator('input[name=name]').fill('Shared genuine fixture');
      await page.locator('select[name=theme]').selectOption('blue');
      await page.getByRole('button', { name: 'Uložit', exact: true }).click();
      await page.getByText('Uloženo', { exact: true }).waitFor();
      assert.equal((await readJson(join(root, 'settings/shared.json'))).name, 'Shared genuine fixture');
      await page.goto(origin + '/content/');
      studio = await studioFrame(page, 'content');
      await studio.getByRole('textbox', { name: 'Nadpis', exact: true }).waitFor();
      assert.equal((await api('/content/api/bootstrap')).value.settings.name, 'Shared genuine fixture');
      assert.equal((await api('/content/api/bootstrap')).value.settings.theme, 'blue');
      assert.equal(await studio.locator('html').getAttribute('data-cms-theme'), 'blue');
      await page.goto(origin + '/site/');
      studio = await studioFrame(page, 'site');
      await studio.locator('#workspace').waitFor({ state: 'visible' });
      assert.equal((await api('/site/api/state')).value.editorName, 'Shared genuine fixture');
      assert.equal(Object.hasOwn(await readJson(join(root, '.sitetiller/config.json')), 'password'), false);
      assert.equal((await readJson(join(root, 'cms/settings.json'))).name, 'LEGACY MUST NOT WIN');
      assert.equal(errors.length, 0, errors.join('\n'));
    } finally {
      if (browser) await browser.close();
      await stack.close();
    }
  },
);
