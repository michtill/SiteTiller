import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, editImage, imageProvider, imageIssues, capabilityImage } from '../src/image-editor.ts';
import { convertImage } from '../src/image-convert.ts';
import { validImages } from '../src/team.ts';
// The image tools with a Google Gemini model (documentation 4.6, 4.7). Invented key in Gemini's shape.
const key = 'AIzaFixtureGeminiKey0000000000000000000';
// PNG signatures with a different last byte: Gemini answers with its own format.
const png = (seed: number) =>
  Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
    Buffer.from([seed]),
  ]).toString('base64');
// A webp signature, as a converter stand-in returns it.
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.from([7])]).toString(
  'base64',
);
// A real 1×1 PNG for the real conversion in Chromium.
const realPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const answer = (data: string) =>
  Response.json({
    candidates: [
      { finishReason: 'STOP', content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data } }] } },
    ],
    usageMetadata: { promptTokenCount: 3 },
  });
test('AI-36: the image models of both providers are told apart and chosen from the catalog', () => {
  assert.equal(imageProvider('gpt-image-2.5-flare'), 'openai');
  assert.equal(imageProvider('gemini-3-pro-image'), 'gemini');
  assert.equal(imageProvider('gemini-3.8-flash'), null);
  assert.equal(validImages({ fast: 'gemini-3.1-flash-image', precise: 'gpt-image-2.5-sunburst' }), true);
  assert.equal(validImages({ fast: 'gemini-3.8-flash', precise: 'none' }), false);
  const models = [{ provider: 'gemini', id: 'gemini-3-pro-image' }];
  assert.equal(capabilityImage('fast', { fast: 'gemini-3-pro-image', precise: 'none' }, models), 'gemini-3-pro-image');
  assert.deepEqual(imageIssues('gemini-3-pro-image', models), []);
  assert.equal(imageIssues('gemini-3.1-flash-image', models).length, 1);
});
test('AI-36: Gemini creates an image through generateContent with the key in its header; it is converted to the requested format', async () => {
  const calls: any[] = [];
  const converted: any[] = [];
  const image = await generateImage(
    key,
    'gemini-3-pro-image',
    'A red bicycle',
    async (url, options: any) => {
      calls.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) });
      return answer(png(1));
    },
    {
      format: 'webp',
      convert: async (data, mime, format) => {
        converted.push({ data, mime, format });
        return webp;
      },
    },
  );
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
  );
  assert.equal(calls[0].headers.get('x-goog-api-key'), key);
  assert.ok(!calls[0].url.includes(key) && !JSON.stringify(calls[0].body).includes(key));
  assert.deepEqual(calls[0].body.generationConfig, { responseModalities: ['IMAGE'] });
  assert.match(calls[0].body.contents[0].parts[0].text, /A red bicycle/);
  assert.deepEqual(converted, [{ data: png(1), mime: 'image/png', format: 'webp' }]);
  assert.equal(image.mime, 'image/webp');
  assert.match(image.id, /\.webp$/);
  assert.equal((image as any).note, undefined);
  // A failed conversion keeps Gemini's PNG and says so: nothing pretends otherwise.
  const kept = await generateImage(key, 'gemini-3-pro-image', 'A red bicycle', async () => answer(png(1)), {
    format: 'webp',
    convert: async () => {
      throw Error('no browser');
    },
  });
  assert.equal(kept.mime, 'image/png');
  assert.equal((kept as any).note, 'Převod do webp se nepodařil; obrázek zůstal ve formátu png.');
});
test('AI-36: the conversion in Chromium produces a real webp and jpeg', { timeout: 60000 }, async () => {
  for (const format of ['webp', 'jpeg'] as const) {
    const bytes = Buffer.from(await convertImage(realPng, 'image/png', format), 'base64');
    if (format === 'webp') assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    else assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255]);
  }
});
test('AI-36: Gemini edits an image with the original as input; a transparent background and a blocked answer are exact errors', async () => {
  const source = { data: png(1), mime: 'image/png' };
  const keep = { format: 'png' as const };
  let body: any;
  const edited = await editImage(
    key,
    'gemini-3-pro-image',
    source,
    'Make it blue',
    async (_url, options: any) => {
      body = JSON.parse(options.body);
      return answer(png(2));
    },
    keep,
  );
  assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/png', data: source.data } });
  assert.match(body.contents[0].parts[0].text, /Make it blue/);
  assert.notEqual(edited.data, source.data);
  // The same picture back is not an edit.
  await assert.rejects(
    editImage(key, 'gemini-3-pro-image', source, 'Make it blue', async () => answer(source.data), keep),
    /nezměněný obrázek/,
  );
  await assert.rejects(
    generateImage(key, 'gemini-3-pro-image', 'Logo', async () => answer(png(3)), { background: 'transparent' }),
    /Průhledné pozadí umí jen obrazové modely OpenAI/,
  );
  await assert.rejects(
    generateImage(key, 'gemini-3-pro-image', 'Something', async () =>
      Response.json({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
    ),
    /Google Gemini obrázek nevytvořil \(SAFETY\)/,
  );
  await assert.rejects(
    generateImage('', 'gemini-3-pro-image', 'X', async () => answer(png(4))),
    /klíč Google Gemini/,
  );
});
