import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
test('ED-19: Formatted content is written as formatted text, stored as Markdown and HTML is not offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-markdown-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data', 'media/images']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'media/images/pixel.png'), pixel);
    const schema = {
      version: 1,
      folders: { images: { label: 'Obrázky', type: 'img' } },
      lists: {
        items: {
          label: 'Items',
          key: 'id',
          columns: {
            id: { label: 'ID', type: 'text', required: true },
            body: { label: 'Body', type: 'markdown' },
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
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole('button', { name: '＋ Nová položka', exact: true }).click();
    await page.getByRole('textbox', { name: 'ID', exact: true }).fill('one');
    // The editor loads with the form; typing gives formatted text.
    const text = page.locator('.markdown-content .ProseMirror');
    await text.click();
    await page.keyboard.type('Úvodní odstavec');
    await page.keyboard.press('Enter');
    // "/" opens the block menu filtered by what follows.
    await page.keyboard.type('/nadpis 2');
    await page.locator('.md-slash').waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Sekce');
    await page.keyboard.press('Enter');
    // Bold from the toolbar.
    await page.locator('.markdown-tools .md-tool', { hasText: 'B' }).dispatchEvent('mousedown');
    await page.keyboard.type('silný');
    await page.locator('.markdown-tools .md-tool', { hasText: 'B' }).dispatchEvent('mousedown');
    await page.keyboard.type(' text');
    await page.keyboard.press('Enter');
    // "+" menu: a table, then an image from a folder.
    const plus = page.getByRole('button', { name: 'Vložit blok' });
    await plus.dispatchEvent('mousedown');
    await page.getByRole('menuitem', { name: /Tabulka/ }).dispatchEvent('mousedown');
    await page.keyboard.type('A');
    await text.click({ position: { x: 20, y: 10 } });
    await plus.dispatchEvent('mousedown');
    await page.getByRole('menuitem', { name: /Obrázek ze složky/ }).dispatchEvent('mousedown');
    await page.locator('.picker .media-grid button').first().click();
    await page.locator('.markdown-content .ProseMirror img').waitFor();
    // Source shows the stored Markdown.
    await page.getByRole('button', { name: 'Zdroj' }).click();
    const markdown = await page.locator('.markdown-source').inputValue();
    assert.match(markdown, /^Úvodní odstavec$/m);
    assert.match(markdown, /^## Sekce$/m);
    assert.match(markdown, /\*\*silný\*\* text/);
    assert.match(markdown, /^\| A /m);
    assert.match(markdown, /!\[pixel\]\(images\/pixel\.png\)/);
    await page.getByRole('button', { name: 'Formátovaně' }).click();
    await page.keyboard.press('Control+s');
    for (let i = 0; i < 50; i++) {
      const rows = JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'));
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = JSON.parse(await readFile(join(root, 'data/items.json'), 'utf8'));
    assert.equal(rows[0].id, 'one');
    assert.match(rows[0].body, /^## Sekce$/m);
    assert.match(rows[0].body, /!\[pixel\]\(images\/pixel\.png\)/);
    // The used image cannot be deleted.
    const usage = await (await fetch(origin + '/api/media-usage?path=images/pixel.png')).json();
    assert.equal(usage.usage.length, 1);
    // The Structure editor offers Formatted content, no longer HTML.
    await page.goto(origin + '/structure');
    await page.getByRole('button', { name: /Přidat pole/ }).click();
    const types = await page.locator('#structure-type option').allTextContents();
    assert.ok(types.includes('Formátovaný obsah (Markdown)'), types.join(', '));
    assert.ok(!types.includes('HTML obsah'), types.join(', '));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
