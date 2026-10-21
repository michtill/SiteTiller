import { decodeImage, imageMime, raster } from './images.ts';
import { convertImage } from './image-convert.ts';
import { diagnosticFetch } from './diagnostics.ts';
import { Project } from './project.ts';
import { withRules } from './instructions.ts';
import { initialImages, type ImageChoices } from './team.ts';

// The image tools use OpenAI (gpt-image-*) or Google Gemini (gemini-*-image) models (documentation 4.6).
export function imageProvider(model: string) {
  return /^gpt-image-[a-zA-Z0-9.-]+$/.test(model)
    ? 'openai'
    : /^gemini-[a-zA-Z0-9.-]*image[a-zA-Z0-9.-]*$/.test(model)
      ? 'gemini'
      : null;
}
// Gemini answers with an image in its own format (usually PNG); it is converted to the requested format in Chromium.
// When that fails the image keeps Gemini's format and the result says so (documentation 4.7).
async function geminiImage(
  key: string,
  model: string,
  prompt: string,
  source: { bytes: Buffer; mime: string } | null,
  fetcher: typeof fetch,
  background: string,
  format: 'png' | 'webp' | 'jpeg',
  convert: typeof convertImage,
) {
  if (!key) throw Error('Obrázky s modelem Gemini potřebují klíč Google Gemini.');
  if (background === 'transparent')
    throw Error('Průhledné pozadí umí jen obrazové modely OpenAI; zvolte v Obrazových nástrojích model OpenAI.');
  const response = await diagnosticFetch(
    fetcher,
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              ...(source ? [{ inline_data: { mime_type: source.mime, data: source.bytes.toString('base64') } }] : []),
            ],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal: AbortSignal.timeout(300000),
    },
  );
  if (!response.ok)
    throw Error(
      (source ? 'Úprava' : 'Generování') +
        ' obrázku: Google Gemini vrátil HTTP ' +
        response.status +
        '. Ověř klíč, dostupnost obrazového modelu a kredit.' +
        (source ? ' Původní obrázek i náhled zůstaly zachované.' : ''),
    );
  const result: any = await response.json(),
    candidate = result.candidates?.[0],
    blocked = result.promptFeedback?.blockReason || (candidate?.finishReason !== 'STOP' && candidate?.finishReason);
  const part = (candidate?.content?.parts || []).find((p: any) => (p.inlineData || p.inline_data)?.data);
  if (!part) throw Error('Google Gemini obrázek nevytvořil' + (blocked ? ' (' + blocked + ')' : '') + '.');
  const name = source ? 'Upravený obrázek' : undefined;
  let image = decodeImage({ data: (part.inlineData || part.inline_data).data, name }),
    note = '';
  if (image.mime !== 'image/' + format)
    try {
      const converted = decodeImage({ data: await convert(image.bytes.toString('base64'), image.mime, format), name });
      if (converted.mime !== 'image/' + format) throw Error('format');
      image = converted;
    } catch {
      note = 'Převod do ' + format + ' se nepodařil; obrázek zůstal ve formátu ' + image.mime.slice(6) + '.';
    }
  return {
    ...image,
    data: image.bytes.toString('base64'),
    usage: result.usageMetadata || {},
    ...(note ? { note } : {}),
  };
}
export function capabilityImage(
  capability: keyof ImageChoices,
  choices: ImageChoices = initialImages(),
  models?: { provider: string; id: string }[],
) {
  const model = choices[capability];
  const provider = imageProvider(model || '');
  if (!model || !provider || (models && !models.some((m) => m.provider === provider && m.id === model)))
    throw Error('Obrázky · ' + capability + ': nakonfigurovaný model není dostupný.');
  return model;
}
export async function generateImage(
  key: string,
  model: string,
  prompt: string,
  fetcher = fetch,
  options: {
    format?: 'png' | 'webp' | 'jpeg';
    background?: 'auto' | 'opaque' | 'transparent';
    convert?: typeof convertImage;
  } = {},
) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) throw Error('Neplatné zadání obrázku.');
  if (imageProvider(model) === 'gemini')
    return geminiImage(
      key,
      model,
      withRules('image', prompt),
      null,
      fetcher,
      options.background || 'auto',
      options.format || 'webp',
      options.convert || convertImage,
    );
  if (!key || !/^gpt-image-[a-zA-Z0-9.-]+$/.test(model))
    throw Error('Generování obrázku potřebuje dostupný model a OpenAI API klíč.');
  const format = options.format || 'webp',
    background = options.background || 'auto';
  if (!['auto', 'opaque', 'transparent'].includes(background) || (background === 'transparent' && format === 'jpeg'))
    throw Error('Průhledné pozadí vyžaduje PNG nebo WebP.');
  if (!['png', 'webp', 'jpeg'].includes(format)) throw Error('Neplatný formát obrázku.');
  const response = await diagnosticFetch(fetcher, 'https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: withRules('image', prompt),
      size: 'auto',
      quality: 'medium',
      output_format: format,
      background,
      ...(format === 'png' ? {} : { output_compression: 85 }),
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw Error('Generování obrázku: OpenAI vrátil HTTP ' + response.status + '.');
  const result: any = await response.json(),
    image = decodeImage({ data: result.data?.[0]?.b64_json });
  if (image.mime !== 'image/' + format) throw Error('Obrazový nástroj nevrátil požadovaný formát.');
  return { ...image, data: image.bytes.toString('base64'), usage: result.usage || {} };
}

export function imageModel(models: { provider: string; id: string }[]) {
  return (
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'].find((id) =>
      models.some((m) => m.provider === 'openai' && m.id === id),
    ) ||
    ['gemini-3-pro-image', 'gemini-3.1-flash-image'].find((id) =>
      models.some((m) => m.provider === 'gemini' && m.id === id),
    ) ||
    null
  );
}
export function imageIssues(selected: string, models: { provider: string; id: string }[]) {
  return !['auto', 'none'].includes(selected) &&
    !models.some((m) => m.provider === imageProvider(selected) && m.id === selected)
    ? ['Obrázky · ' + selected + ': model není dostupný.']
    : [];
}

// Only local, committed website assets are read. Never fetch model-supplied URLs.
export async function websiteImages(project: Project, commit: string, files: Record<string, string>) {
  const text = Object.entries(files)
    .filter(([path]) => !raster(path))
    .map(([, value]) => value)
    .join('\n');
  const images: any[] = [];
  let total = 0;
  for (const path of Object.keys(files).filter((path) => raster(path) && text.includes(path.slice(5)))) {
    if (images.length === 4) break;
    const bytes = await project.binary(commit, path);
    if (bytes.length > 5 * 1024 * 1024 || total + bytes.length > 8 * 1024 * 1024) continue;
    total += bytes.length;
    images.push({ path, name: path, mime: imageMime(path), data: bytes.toString('base64'), use: 'website' });
  }
  return images;
}

export async function editImage(
  key: string,
  model: string,
  source: { data: string; mime: string },
  prompt: string,
  fetcher = fetch,
  options: {
    format?: 'png' | 'webp' | 'jpeg';
    background?: 'auto' | 'opaque' | 'transparent';
    convert?: typeof convertImage;
  } = {},
) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000)
    throw Error('Neplatné zadání úpravy obrázku.');
  const input = decodeImage({ data: source.data });
  const instruction =
    'Edit the supplied image according to the following request. Preserve the subject, identity, composition and aspect ratio except where the request explicitly asks to change them. Do not add text, logos or watermarks.\n' +
    prompt;
  if (imageProvider(model) === 'gemini') {
    const edited = await geminiImage(
      key,
      model,
      withRules('image', instruction),
      input,
      fetcher,
      options.background || 'auto',
      options.format || 'webp',
      options.convert || convertImage,
    );
    if (edited.bytes.equals(input.bytes)) throw Error('Obrazový model vrátil nezměněný obrázek.');
    return edited;
  }
  if (!key) throw Error('Úprava obrázků potřebuje OpenAI API klíč.');
  if (!/^gpt-image-[a-zA-Z0-9.-]+$/.test(model)) throw Error('Neplatný model pro obrázky.');
  const format = options.format || 'webp',
    background = options.background || 'auto';
  if (!['auto', 'opaque', 'transparent'].includes(background) || (background === 'transparent' && format === 'jpeg'))
    throw Error('Průhledné pozadí vyžaduje PNG nebo WebP.');
  if (!['png', 'webp', 'jpeg'].includes(format)) throw Error('Neplatný výstupní formát obrázku.');
  const body = new FormData();
  body.set('model', model);
  body.set('prompt', withRules('image', instruction));
  body.append('image[]', new Blob([input.bytes], { type: input.mime }), input.id);
  body.set('size', 'auto');
  body.set('quality', 'medium');
  body.set('output_format', format);
  body.set('background', background);
  if (format !== 'png') body.set('output_compression', '85');
  if (/^gpt-image-1(?:\.5)?$/.test(model)) body.set('input_fidelity', 'high');
  const response = await diagnosticFetch(fetcher, 'https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body,
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok)
    throw Error(
      'Úprava obrázku: OpenAI vrátil HTTP ' +
        response.status +
        '. Ověř klíč, dostupnost obrazového modelu a kredit. Původní obrázek i náhled zůstaly zachované.',
    );
  const result: any = await response.json(),
    image = decodeImage({ data: result.data?.[0]?.b64_json, name: 'Upravený obrázek' });
  if (image.bytes.equals(input.bytes)) throw Error('Obrazový model vrátil nezměněný obrázek.');
  if (options.format && image.mime !== 'image/' + format)
    throw Error('Obrazový nástroj nevrátil požadovaný formát ' + format + '.');
  return { ...image, data: image.bytes.toString('base64'), usage: result.usage || {} };
}
