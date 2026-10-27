import { chromium } from 'playwright';
// Uses SITETILLER_BROWSER_EXECUTABLE (e.g. an installed Chrome) when Playwright's own browser is not installed.
export const launchBrowser = () =>
  chromium.launch({
    headless: true,
    ...(process.env.SITETILLER_BROWSER_EXECUTABLE ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE } : {}),
  });
// The Shell keeps both studios and Settings alive in iframes; this returns the frame of the requested one ('site',
// 'content' or 'settings') once loaded.
export async function studioFrame(page, name) {
  const handle = await page.waitForSelector(
    'iframe[title="' + { site: 'AI Studio', content: 'Editor obsahu', settings: 'Nastavení' }[name] + '"]',
    { state: 'attached' },
  );
  const frame = await handle.contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}
