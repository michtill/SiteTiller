import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
test('ED-09: discard dialog immediately blocks confirmation while loading and explicitly discards unsaved form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publication-dialog-'));
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
    const origin = 'http://127.0.0.1:4630';
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        PORT: '4630',
      },
      windowsHide: true,
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(origin + '/api/bootstrap')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const boot = await (await fetch(origin + '/api/bootstrap')).json(),
      revision = (await (await fetch(origin + '/api/design-restore-state')).json()).revision;
    const headers = { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/json' };
    assert.equal(
      (
        await fetch(origin + '/api/publication', {
          method: 'POST',
          headers,
          body: JSON.stringify({ confirm: false, expectedRevision: revision }),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(origin + '/api/publication', {
          method: 'POST',
          headers,
          body: JSON.stringify({ confirm: true, expectedRevision: revision }),
        })
      ).status,
      200,
    );
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Stored pending"}]');
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved local change');
    assert.equal(await page.getByRole('button', { name: 'Publikovat úpravy', exact: true }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Odstranit úpravy', exact: true }).isDisabled(), false);
    let release;
    await page.route(
      '**/api/design-restore-state',
      (route) =>
        new Promise((resolve) => {
          release = async () => {
            await route.continue();
            resolve();
          };
        }),
    );
    await page.getByRole('button', { name: 'Odstranit úpravy', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Neuložené úpravy' })
      .getByRole('button', { name: 'Storno', exact: true })
      .click();
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Unsaved local change');
    await page.getByRole('button', { name: 'Odstranit úpravy', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Neuložené úpravy' })
      .getByRole('button', { name: 'Zahodit úpravy', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Odstranit úpravy', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Odstranit úpravy', exact: true }).isDisabled(), true);
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    await dialog.getByRole('button', { name: 'Zrušit', exact: true }).click();
    await release();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Stored pending');
    release = undefined;
    await page.getByRole('button', { name: 'Odstranit úpravy', exact: true }).click();
    await dialog.waitFor();
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    await release();
    await dialog.getByRole('button', { name: 'Odstranit úpravy', exact: true }).click();
    try {
      await dialog.waitFor({ state: 'hidden' });
    } catch (e) {
      throw Error(await dialog.innerText());
    }
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Published original');
    assert.equal((await (await fetch(origin + '/api/edit-mode')).json()).autoPublish, false);
    assert.equal(await page.getByRole('button', { name: 'Publikovat úpravy', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Odstranit úpravy', exact: true }).count(), 0);
    await page.getByLabel('Živá editace', { exact: true }).waitFor();
    assert.match(await page.locator('.publication-status').textContent(), /^Publikováno /);
    const top = await page.locator('.studio-brand-row').evaluate((el) => el.getBoundingClientRect().top);
    await page.locator('.sidebar-scroll').evaluate((el) => {
      const spacer = document.createElement('div');
      spacer.style.height = '1500px';
      spacer.style.flexShrink = '0';
      el.append(spacer);
      el.scrollTop = 700;
    });
    assert.equal(await page.locator('.studio-brand-row').evaluate((el) => el.getBoundingClientRect().top), top);
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
