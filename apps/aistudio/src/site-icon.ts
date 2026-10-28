import { launchBrowser } from './checks.ts';
// Prepare the website icon (documentation 4.11): one square image becomes the icon files every browser and phone looks
// for, made in Chromium like the other image conversions (4.7), with no new dependency. The image is cropped to its
// centre square; the original stays as it is.
export const siteIconFiles = ['site/favicon.ico', 'site/favicon-32.png', 'site/apple-touch-icon.png'];
export const siteIconLinks =
  '<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

export async function siteIcons(source: Buffer, mime: string) {
  const { chromium } = await import('playwright');
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage();
    const sizes = (await page.evaluate(
      async ({ data, mime }: { data: string; mime: string }) => {
        const image = new Image();
        image.src = 'data:' + mime + ';base64,' + data;
        await image.decode();
        const side = Math.min(image.naturalWidth, image.naturalHeight),
          x = (image.naturalWidth - side) / 2,
          y = (image.naturalHeight - side) / 2;
        const out: Record<string, string> = {};
        for (const size of [32, 180]) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const context = canvas.getContext('2d')!;
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, x, y, side, side, 0, 0, size, size);
          out[size] = canvas.toDataURL('image/png').split(',')[1];
        }
        return out;
      },
      { data: source.toString('base64'), mime },
    )) as Record<string, string>;
    const png32 = Buffer.from(sizes[32], 'base64'),
      png180 = Buffer.from(sizes[180], 'base64');
    return { 'site/favicon.ico': ico(png32), 'site/favicon-32.png': png32, 'site/apple-touch-icon.png': png180 };
  } finally {
    await browser.close().catch(() => {});
  }
}

// An ICO file holding one 32×32 PNG image (valid since Windows Vista and in every current browser).
export function ico(png: Buffer) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

// The links in the head of every page and page template of the website that has no icon link yet.
export function withIconLinks(files: Record<string, string>) {
  const changed: Record<string, string> = {};
  for (const [path, text] of Object.entries(files))
    if (
      path.endsWith('.html') &&
      !path.startsWith('site/cms/') &&
      /<\/head>/i.test(text) &&
      !/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(text)
    )
      changed[path] = text.replace(/<\/head>/i, siteIconLinks + '</head>');
  return changed;
}
