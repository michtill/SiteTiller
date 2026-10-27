import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const schema = (label) => ({
  version: 1,
  folders: { docs: { label: 'Docs', type: 'other' }, photos: { label: 'Photos', type: 'img' } },
  lists: { items: { label, key: 'id', columns: { id: { label: 'ID', type: 'text' } } } },
});
test('ED-17: the published view opens the Structure editor read-only; the working view can still change it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-published-structure-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data', '.production/release/cms/data'])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, '.production/release/cms/structure.json'), JSON.stringify(schema('Published items')));
    await writeFile(join(root, '.production/release/cms/data/items.json'), '[{"id":"one"}]');
    await writeFile(
      join(root, '.production/current.json'),
      JSON.stringify({ id: 'prod-original', directory: join(root, '.production/release') }),
    );
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema('Working items')));
    await writeFile(join(root, 'data/items.json'), '[{"id":"one"}]');
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
    page.setDefaultTimeout(10000);
    await page.goto(origin);
    await page.locator('.publication-view-menu summary').click();
    await page.locator('.publication-view-options button').nth(1).click();
    await page.locator('.publication-view-label .publication-readonly').waitFor();
    // Previously the Structure editor was disabled in the published view.
    assert.equal(await page.locator('.structure-entry').isEnabled(), true);
    await page.locator('.structure-entry').click();
    const name = page.locator('.structure-editor .fields input').first();
    await name.waitFor();
    assert.equal(await name.inputValue(), 'Published items');
    assert.equal(await name.isEditable(), false);
    assert.equal(await page.locator('.architect-toolbar .publication-readonly').isVisible(), true);
    assert.equal(await page.locator('.architect-controls').count(), 0);
    // Every control stays in place, disabled, so the read-only view looks like the editable one.
    assert.equal(await page.locator('.structure-list .primary').isDisabled(), true);
    assert.ok((await page.locator('.drag-handle').count()) > 0);
    for (const button of await page.locator('.drag-handle, .field-controls button, .structure-footer button').all())
      assert.equal(await button.isDisabled(), true);
    // Browsing still works: field details and the folders tab open.
    await page.locator('.field-toggle').first().click();
    assert.equal(await page.locator('.field-details input').first().isEditable(), false);
    await page.locator('.architect-tabs button').nth(1).click();
    const folderName = page.locator('.folders-layout .structure-editor .fields input').first();
    assert.equal(await folderName.inputValue(), 'Docs');
    assert.equal(await folderName.isEditable(), false);
    assert.equal(await page.locator('.folders-layout .drag-handle').first().isDisabled(), true);
    await page.locator('.architect-back').click();
    await page.locator('.publication-view-menu summary').click();
    await page.locator('.publication-view-options button').first().click();
    await page.locator('.publication-view-label .publication-readonly').waitFor({ state: 'detached' });
    await page.locator('.structure-entry').click();
    await name.waitFor();
    assert.equal(await name.inputValue(), 'Working items');
    assert.equal(await name.isEditable(), true);
    assert.equal(await page.locator('.architect-controls').count(), 1);
    // Working structure: folders are reordered like collections and saved in that order.
    await page.locator('.architect-tabs button').nth(1).click();
    await page.locator('.folders-layout .drag-handle').first().press('ArrowDown');
    assert.deepEqual(await page.locator('.folders-layout .structure-item strong').allTextContents(), [
      'Photos',
      'Docs',
    ]);
    await page.locator('.architect-controls .primary').click();
    await page.waitForFunction(async () => {
      const boot = await (await fetch('/api/bootstrap')).json();
      return Object.keys(boot.schema.folders).join() === 'photos,docs';
    });
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
