import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
const root = join(
  process.env.SITETILLER_NEXT_INSTANCES || 'C:/Dev/sitetiller-next-instances',
  process.env.SITETILLER_NEXT_INSTANCE || 'playground',
);
const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8')),
  origin = 'http://127.0.0.1:' + instance.ports.shell,
  website = 'http://127.0.0.1:' + instance.ports.website;
const password = (await readFile(join(root, 'settings/playground-password.txt'), 'utf8')).trim();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/login');
  await page.locator('input[name=password]').fill(password);
  await page.locator('button:not(.show-password)').click();
  await page.waitForURL('**/content/');
  await page.getByRole('textbox', { name: 'Nadpis', exact: true }).waitFor();
  if ((await page.getByRole('textbox', { name: 'Nadpis', exact: true }).inputValue()) !== 'SiteTiller playground')
    throw Error('Playground is not clean fixture');
  if ((await page.evaluate(() => document.baseURI)) !== origin + '/content/') throw Error('Incorrect CM base');
  await page.goto(origin + '/site/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('preview').src.includes('/preview/access/'));
  await page.frameLocator('#preview').getByRole('heading', { name: 'SiteTiller playground', exact: true }).waitFor();
  const state = await page.evaluate(async () => await (await fetch('/site/api/state')).json());
  if (state.busy || state.cmsDirty || state.providers.some((p) => p.hasKey))
    throw Error('Playground is not clean idle offline fixture');
  await page.goto(website + '/');
  await page.getByRole('heading', { name: 'SiteTiller playground', exact: true }).waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    'Read-only browser smoke passed: real CMStudio, AIStudio, sandbox preview and frozen website; clean seed, idle, no provider keys.',
  );
} finally {
  await browser.close();
}
