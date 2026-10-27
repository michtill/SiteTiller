import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
test('ED-04: focus loads external changes, protects dirty form and shows published content readonly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-focus-'));
  let child, browser;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        lists: {
          items: {
            label: 'Items',
            key: 'id',
            columns: { id: { label: 'ID', type: 'text' }, title: { label: 'Title', type: 'text' } },
          },
        },
        folders: {},
      }),
    );
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Published original"}]');
    const origin = 'http://127.0.0.1:4633';
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        PORT: '4633',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(origin + '/api/bootstrap')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const boot = await (await fetch(origin + '/api/bootstrap')).json(),
      headers = { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/json' },
      state = await (await fetch(origin + '/api/design-restore-state')).json();
    await fetch(origin + '/api/publication', {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: true, expectedRevision: state.revision }),
    });
    const update = async (title) => {
      const b = await (await fetch(origin + '/api/bootstrap')).json();
      const res = await fetch(origin + '/api/design-content', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          schemaRevision: b.schemaRevision,
          changes: [{ collection: 'items', revision: b.lists.items.revision, rows: [{ id: 'one', title }] }],
        }),
      });
      assert.equal(res.status, 200);
    };
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
    await update('External edit');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('[aria-label="Title"]').value === 'External edit');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('My unsaved edit');
    await update('Latest external');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('Obsah byl upraven jinde.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'My unsaved edit');
    assert.equal(await page.getByText('Zobrazený obsah', { exact: true }).count(), 0);
    await page.locator('.publication-view-menu summary').click();
    await page
      .locator('.publication-view-options')
      .getByRole('button', { name: /Publikováno/ })
      .click();
    await page
      .getByRole('dialog', { name: 'Neuložené úpravy' })
      .getByRole('button', { name: 'Zahodit úpravy', exact: true })
      .click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Title"]').value === 'Published original');
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).evaluate((el) => el.readOnly), true);
    assert.equal(await page.getByRole('button', { name: 'Uložit úpravy', exact: true }).count(), 0);
    // The published structure can be browsed read-only (published-structure.test.mjs).
    assert.equal(await page.getByRole('button', { name: 'Struktura', exact: true }).isEnabled(), true);
    await page.locator('.publication-view-menu summary').click();
    await page
      .locator('.publication-view-options')
      .getByRole('button', { name: 'Nepublikované úpravy', exact: true })
      .click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Title"]').value === 'Latest external');
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).evaluate((el) => el.readOnly), false);
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
