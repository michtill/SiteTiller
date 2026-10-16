import { chromium } from 'playwright';
// Uses SITETILLER_BROWSER_EXECUTABLE (e.g. an installed Chrome) when Playwright's own browser is not installed.
export const launchBrowser = () =>
  chromium.launch({
    headless: true,
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
  });
// The Shell keeps both studios alive in iframes; this returns the frame of the requested studio once loaded.
export async function studioFrame(page, name) {
  const handle = await page.waitForSelector(
    'iframe[title="' + (name === 'site' ? 'AI Studio' : 'Editor obsahu') + '"]',
    { state: 'attached' },
  );
  const frame = await handle.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}
// AI settings live in the studio menu: open the menu, then the dialog. Without usable models (offline
// fixtures) the studio opens the dialog by itself shortly after loading; then it is already open.
export async function openAiSettings(frame) {
  await frame.waitForFunction(() => !document.getElementById('settings-button')?.disabled);
  for (let i = 0; i < 20 && !(await frame.locator('#settings[open]').count()); i++) await frame.waitForTimeout(150);
  if (await frame.locator('#settings[open]').count()) return;
  await frame.locator('#studio-switcher summary').click();
  await frame.locator('#settings-button').click();
}
