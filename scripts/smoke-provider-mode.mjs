import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { instancesDirectory } from './instances-dir.mjs';
const root = join(
    instancesDirectory(),
    process.env.SITETILLER_INSTANCE_NAME || 'playground',
  ),
  instance = JSON.parse(await readFile(root + '/instance.json', 'utf8')),
  origin = 'http://127.0.0.1:' + instance.ports.shell;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/login');
  await page
    .locator('input[name=password]')
    .fill((await readFile(root + '/settings/playground-password.txt', 'utf8')).trim());
  await page.locator('button:not(.show-password)').click();
  await page.waitForURL('**/content/');
  await page.goto(origin + '/site/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  if (!(await page.locator('#settings').isVisible())) await page.locator('#settings-button').click();
  await page.locator('#provider-network-note').waitFor();
  if (!/povolené/.test(await page.locator('#provider-network-note').textContent()))
    throw Error('Provider mode not reflected in UI');
  if (
    (await page.locator('#key-openai').getAttribute('type')) !== 'password' ||
    (await page.locator('#key-anthropic').getAttribute('type')) !== 'password'
  )
    throw Error('Keys must use protected fields');
  await page.locator('#key-save-hint').waitFor();
  if (!/klíče neukládá/.test(await page.locator('#key-save-hint').textContent()))
    throw Error('Missing distinction between check and save');
  await page.locator('#key-status-openai').waitFor();
  await page.locator('#key-status-anthropic').waitFor();
  if (errors.length) throw Error('UI JavaScript error');
  console.log(
    'Provider-mode AI UI passed; protected key inputs and enabled-network notice visible. No key values read, no generation.',
  );
} finally {
  await browser.close();
}
