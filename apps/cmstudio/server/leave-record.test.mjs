import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
test('ED-03: leave edited record offers save/discard/cancel and failed save retains draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leave-record-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data', 'media']) await mkdir(join(root, dir));
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: {},
        lists: {
          items: {
            label: 'Items',
            key: 'id',
            columns: {
              id: { label: 'ID', type: 'text', required: true },
              title: { label: 'Title', type: 'text', required: true },
            },
          },
        },
      }),
    );
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"One"},{"id":"two","title":"Two"}]');
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
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(origin + '/api/bootstrap')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    const title = page.getByRole('textbox', { name: 'Title', exact: true }),
      id = page.getByRole('textbox', { name: 'ID', exact: true }),
      dialog = page.getByRole('dialog', { name: 'Neuložené úpravy' });
    await title.fill('Unsaved');
    await page.locator('.record-select').nth(1).click();
    await dialog.waitFor();
    for (const name of ['Uložit', 'Zahodit úpravy', 'Storno'])
      assert.equal(await dialog.getByRole('button', { name, exact: true }).count(), 1);
    await dialog.getByRole('button', { name: 'Storno', exact: true }).click();
    assert.equal(await title.inputValue(), 'Unsaved');
    assert.equal(await id.inputValue(), 'one');
    await page.locator('.record-select').nth(1).click();
    await dialog.getByRole('button', { name: 'Zahodit úpravy', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="ID"]')?.value === 'two');
    assert.equal(await title.inputValue(), 'Two');
    assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].title, 'One');
    await title.fill('Saved Two');
    await page.locator('.record-select').nth(0).click();
    await dialog.getByRole('button', { name: 'Uložit', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="ID"]')?.value === 'one');
    assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[1].title, 'Saved Two');
    await id.fill('two');
    await title.fill('Failed draft');
    await page.locator('.record-select').nth(1).click();
    await dialog.getByRole('button', { name: 'Uložit', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'již existuje' }).waitFor();
    assert.equal(await title.inputValue(), 'Failed draft');
    assert.equal(await id.inputValue(), 'two');
    assert.equal(await dialog.count(), 0);
    assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].title, 'One');
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
