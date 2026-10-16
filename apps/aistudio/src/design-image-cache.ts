import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeImage } from './images.ts';
export async function rememberImage(directory: string, image: any, metadata: any = {}) {
  const decoded = decodeImage({ data: image.data });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, decoded.id), decoded.bytes, { mode: 0o600 });
  const value = {
    id: decoded.id,
    path: 'site/assets/' + decoded.id,
    mime: decoded.mime,
    prompt: metadata.prompt || '',
    originalTarget: metadata.path || null,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(directory, decoded.id + '.json'), JSON.stringify(value), { mode: 0o600 });
  return value;
}
export async function rememberedImages(directory: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const result: any[] = [];
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.(png|jpg|webp)\.json$/.test(name)).slice(-40))
    try {
      const meta = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const image = decodeImage({ data: (await readFile(join(directory, name.slice(0, -5)))).toString('base64') });
      if (image.id !== name.slice(0, -5)) continue;
      result.push({ ...meta, ...image, data: image.bytes.toString('base64'), path: 'site/assets/' + image.id });
    } catch {}
  return result;
}
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export function collectionImageRequest(prompt: string, cms: any) {
  if (!cms?.readOnly) return false;
  const text = fold(prompt);
  if (
    !/\b(vytvor|uprav|zmen|nahrad|pridej|create|replace|generate|change|new|nove)\w*/.test(text) ||
    !/(obraz|fotograf|ilustr|image|photo|picture)/.test(text)
  )
    return false;
  return Object.entries(cms.schema.lists || {}).some(([name, def]: [string, any]) =>
    [name, def.label].filter(Boolean).some((label) => {
      const value = fold(label);
      return value.length > 2 && text.includes(value);
    }),
  );
}
export const contentPermissionMessage =
  'Tento požadavek mění obsah. Nejprve přepněte na Nepublikovaný obsah a potom požadavek odešlete znovu. Publikovaný obsah je pouze pro čtení.';
