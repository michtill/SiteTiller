import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
// A 1×1 PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=',
  'base64',
);
test('ED-24: an image in the images folder and the selected image of a record open large over the editor; a click beside it, the close button or Esc hides it, a click on it does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-image-viewer-'));
  let child, browser;
  try {
    for (const dir of ['schema', 'data', 'media/images']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: { images: { label: 'Pictures', type: 'img' } },
        lists: {
          items: {
            label: 'Items',
            key: 'id',
            columns: {
              id: { label: 'ID', type: 'text', required: true },
              photo: { label: 'Photo', type: 'file', folder: 'images' },
            },
          },
        },
      }),
    );
    await writeFile(join(root, 'data/items.json'), JSON.stringify([{ id: 'one', photo: 'images/cover.png' }]));
    await writeFile(join(root, 'media/images/cover.png'), png);
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    const viewer = page.getByRole('dialog', { name: 'images/cover.png' });
    // The selected image in the record form.
    await page.getByRole('button', { name: 'Zobrazit obrázek images/cover.png' }).click();
    await viewer.waitFor();
    assert.match(await viewer.locator('img').getAttribute('src'), /cover\.png/);
    // A click on the image keeps it; a click beside it hides it.
    await viewer.locator('img').click();
    assert.equal(await viewer.isVisible(), true);
    await page.mouse.click(10, 10);
    await viewer.waitFor({ state: 'detached' });
    // An image in the folder; Esc and the close button hide it too.
    await page.locator('.sidebar').getByText('Pictures').click();
    const open = page.locator('.media-grid').getByRole('button', { name: 'Zobrazit obrázek images/cover.png' });
    await open.click();
    await viewer.waitFor();
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    await open.click();
    await viewer.getByRole('button', { name: 'Zavřít', exact: true }).click();
    await viewer.waitFor({ state: 'detached' });
  } finally {
    await browser?.close();
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
