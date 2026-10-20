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
