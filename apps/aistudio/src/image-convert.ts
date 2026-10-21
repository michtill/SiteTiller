// Converts an image to the requested format in the Chromium the checks already use (documentation 4.7): a Gemini
// image comes as PNG, the website usually wants webp. The picture is redrawn on a canvas; jpeg gets a white
// background (it has no transparency). Quality 0.85, the same level as the OpenAI images (output_compression 85).
export async function convertImage(data: string, mime: string, format: 'png' | 'webp' | 'jpeg') {
  const { chromium } = await import('playwright'),
    { launchBrowser } = await import('./checks.ts');
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const result: string = await page.evaluate(
      async ({ data, mime, type }: { data: string; mime: string; type: string }) => {
        const blob = await (await fetch('data:' + mime + ';base64,' + data)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = canvas.getContext('2d')!;
        if (type === 'image/jpeg') {
          context.fillStyle = '#fff';
          context.fillRect(0, 0, bitmap.width, bitmap.height);
        }
        context.drawImage(bitmap, 0, 0);
        const out = await canvas.convertToBlob({ type, quality: 0.85 });
        if (out.type !== type) throw Error('format');
        const bytes = new Uint8Array(await out.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      },
      { data, mime, type: 'image/' + format },
    );
    return result;
  } finally {
    await browser.close();
  }
}
