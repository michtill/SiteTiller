import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
test('ST-03: readonly fields accept initial values and lock immediately after save and reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-readonly-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data']) await mkdir(join(root, dir));
    const schema = {
      version: 1,
      folders: {},
      lists: {
        items: {
          label: 'Items',
          key: 'id',
          columns: {
            id: { label: 'ID', type: 'text', readonly: true, required: true },
            title: { label: 'Title', type: 'text', readonly: true, required: true },
            flag: { label: 'Flag', type: 'checkbox', readonly: true },
            html: { label: 'Body', type: 'html', readonly: true },
            notes: { label: 'Notes', type: 'text' },
            order: { label: 'Pořadí skladby na albu', type: 'number' },
          },
        },
      },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/items.json'), '[]');
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
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    const id = page.getByRole('textbox', { name: 'ID', exact: true }),
      title = page.getByRole('textbox', { name: 'Title', exact: true }),
      html = page.getByRole('textbox', { name: 'Body', exact: true }),
      flag = page.getByRole('checkbox', { name: 'Flag', exact: true });
    assert.equal(await id.isEditable(), true);
    assert.equal(await title.isEditable(), true);
    assert.equal(await flag.isEnabled(), true);
    assert.equal(await html.getAttribute('contenteditable'), 'true');
    await page.getByRole('spinbutton', { name: 'Pořadí skladby na albu', exact: true }).fill('1');
    await id.fill('one');
    await title.fill('Initial');
    await flag.check();
    await html.fill('Initial body');
    await page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="ID"]')?.readOnly === true);
    assert.equal(await id.isEditable(), false);
    assert.equal(await title.isEditable(), false);
    assert.equal(await flag.isDisabled(), true);
    assert.equal(await html.getAttribute('contenteditable'), 'false');
    assert.equal(JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'))[0].order, '1');
    await page.getByRole('spinbutton', { name: 'Pořadí skladby na albu', exact: true }).fill('-2.5');
    await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Editable later');
    await page.getByRole('button', { name: 'Uložit úpravy', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.badge')?.textContent === 'Uloženo');
    const rows = JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'));
    assert.equal(rows[0].id, 'one');
    assert.equal(rows[0].title, 'Initial');
    assert.equal(rows[0].flag, 'true');
    assert.match(rows[0].html, /Initial body/);
    assert.equal(rows[0].notes, 'Editable later');
    assert.equal(rows[0].order, '-2.5');
    await page.reload();
    assert.equal(await id.isEditable(), false);
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    assert.equal(await id.isEditable(), true);
    assert.equal(await flag.isEnabled(), true);
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
