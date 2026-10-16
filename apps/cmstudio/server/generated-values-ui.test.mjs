import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
test('ST-03: new collection Code defaults to generated pattern and values assign on save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generated-ui-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data', 'media']) await mkdir(join(root, dir));
    await writeFile(join(root, 'schema/structure.json'), '{"version":1,"lists":{},"folders":{}}');
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
    await page.getByRole('button', { name: 'Editor struktury', exact: true }).click();
    await page.getByRole('button', { name: '＋ Přidat kolekci', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Přidat do struktury' });
    await add.getByLabel('Název', { exact: true }).fill('Alba');
    await add.getByLabel('Kód', { exact: true }).fill('albums');
    await add.getByRole('button', { name: 'Přidat', exact: true }).click();
    const field = page.locator('.field-definition[data-order-key="code"]');
    await field.locator('.field-toggle').click();
    assert.equal(await field.getByLabel('Typ pole').inputValue(), 'generated');
    const pattern = field.getByLabel('Vzorec hodnoty');
    assert.equal(await pattern.inputValue(), 'albums-####');
    assert.equal(await field.getByRole('checkbox', { name: 'Jen pro čtení', exact: true }).isChecked(), true);
    // A read-only generated value may become editable for a new item; off by default.
    assert.equal(await field.getByRole('checkbox', { name: 'Lze změnit u nové položky' }).isChecked(), false);
    assert.equal(await field.getByRole('checkbox', { name: 'Lze změnit u nové položky' }).isEnabled(), true);
    assert.equal(await field.getByText('Výchozí hodnota', { exact: true }).count(), 0);
    await pattern.fill('missing-number');
    await page.getByRole('button', { name: 'Uložit strukturu', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'alespoň #' }).waitFor();
    assert.equal(JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8')).lists.albums, undefined);
    await page.getByRole('button', { name: 'Zavřít zprávu', exact: true }).click();
    await pattern.fill('alb##');
    await page.getByRole('button', { name: 'Uložit strukturu', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('.architect-tabs .badge')?.textContent?.includes('Uloženo'),
    );
    const saved = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
    assert.equal(saved.lists.albums.columns.code.type, 'generated');
    assert.equal(saved.lists.albums.columns.code.valuePattern, 'alb##');
    await page.getByRole('button', { name: '← Editor obsahu', exact: true }).click();
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    const code = page.getByRole('textbox', { name: 'Kód', exact: true });
    assert.equal(await code.isEditable(), false);
    await page.waitForFunction(() => document.querySelector('input[aria-label="Kód"]')?.value === 'alb01');
    await assert.rejects(readFile(join(root, '.cmstudio-sequences.json')), (e) => e.code === 'ENOENT');
    await page.getByRole('textbox', { name: 'Název', exact: true }).fill('První album');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/lists/albums') && r.request().method() === 'PUT' && r.status() === 200,
      ),
      page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click(),
    ]);
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="Kód"]')?.value === 'alb01' &&
        document.querySelector('.editor-heading .eyebrow')?.textContent === 'ÚPRAVA ZÁZNAMU',
    );
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    await page.getByRole('textbox', { name: 'Název', exact: true }).fill('Druhé album');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/lists/albums') && r.request().method() === 'PUT' && r.status() === 200,
      ),
      page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector('input[aria-label="Kód"]')?.value === 'alb02');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/albums.json'), 'utf8')).map((r) => r.code),
      ['alb01', 'alb02'],
    );
    await page.getByRole('button', { name: 'Editor struktury', exact: true }).click();
    const codeDefinition = page.locator('.field-definition[data-order-key="code"]');
    await codeDefinition.locator('.field-toggle').click();
    await codeDefinition.getByRole('checkbox', { name: 'Jen pro čtení', exact: true }).uncheck();
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/structure') && r.status() === 200),
      page.getByRole('button', { name: 'Uložit strukturu', exact: true }).click(),
    ]);
    await page.waitForFunction(() =>
      document.querySelector('.architect-tabs .badge')?.textContent?.includes('Uloženo'),
    );
    await page.getByRole('button', { name: '← Editor obsahu', exact: true }).click();
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Kód"]')?.value === 'alb03');
    assert.equal(await code.isEditable(), true);
    await code.fill('my-code');
    await page.getByRole('textbox', { name: 'Název', exact: true }).fill('Custom');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/lists/albums') && r.status() === 200),
      page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click(),
    ]);
    await page.waitForFunction(
      () => document.querySelector('.editor-heading .eyebrow')?.textContent === 'ÚPRAVA ZÁZNAMU',
    );
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Kód"]')?.value === 'alb03');
    assert.equal(JSON.parse(await readFile(join(root, '.cmstudio-sequences.json'), 'utf8')).counters.albums.code, '2');
    await code.fill('my-code');
    await page.getByRole('textbox', { name: 'Název', exact: true }).fill('Duplicate stays');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/lists/albums') && r.status() === 422),
      page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click(),
    ]);
    await page.getByRole('status').filter({ hasText: 'již existuje' }).waitFor();
    assert.equal(await code.inputValue(), 'my-code');
    assert.equal(await page.getByRole('textbox', { name: 'Název', exact: true }).inputValue(), 'Duplicate stays');
    assert.equal(JSON.parse(await readFile(join(root, 'data/albums.json'), 'utf8')).length, 3);
    assert.equal(JSON.parse(await readFile(join(root, '.cmstudio-sequences.json'), 'utf8')).counters.albums.code, '2');
    await code.fill('corrected-code');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/lists/albums') && r.status() === 200),
      page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click(),
    ]);
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
