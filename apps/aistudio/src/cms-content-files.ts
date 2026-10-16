import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { binaryAsset } from './images.ts';
import { safeSitePath } from './core.ts';
export async function stageContentFiles(
  requests: any,
  source: any,
  root: string,
  files: Record<string, string>,
  binary: Record<string, Buffer>,
  assets: any[],
  supplied: { path: string; data: string }[] = [],
) {
  if (requests === undefined) return;
  if (source?.readOnly !== false) throw Error('Publikovaný obsah je pouze pro čtení.');
  if (!Array.isArray(requests) || requests.length > 10)
    throw Error('Přidejte nejvýše deset souborů v jednom požadavku.');
  for (const item of requests) {
    if (
      !item ||
      typeof item.source !== 'string' ||
      typeof item.folder !== 'string' ||
      typeof item.name !== 'string' ||
      Object.keys(item).some((k) => !['source', 'folder', 'name'].includes(k))
    )
      throw Error('Neplatné přidání souboru.');
    const folder = source.schema.folders?.[item.folder];
    if (!folder) throw Error('Složka není definovaná ve struktuře.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}$/.test(item.name) || item.name.includes('..'))
      throw Error('Neplatný název souboru.');
    const target = 'site/cms/files/' + item.folder + '/' + item.name;
    safeSitePath(root, target);
    safeSitePath(root, item.source);
    if (!Object.hasOwn(files, item.source)) throw Error('Zdrojový soubor není součástí návrhu.');
    const previous = assets.find((asset) => asset.folder === item.folder && asset.name === item.name);
    if (previous) {
      if (previous.source !== item.source) throw Error('Cílový soubor se opakuje.');
      continue;
    }
    if (
      Object.hasOwn(files, target) ||
      source.media.some((asset: any) => asset.source === item.folder + '/' + item.name)
    )
      throw Error('Existující soubor nelze přepsat. Zvolte nový název.');
    const suppliedFile = supplied.find((file) => file.path === item.source);
    const bytes =
      binary[item.source] ||
      (suppliedFile
        ? Buffer.from(suppliedFile.data, 'base64')
        : binaryAsset(item.source)
          ? await readFile(safeSitePath(root, item.source))
          : Buffer.from(files[item.source], 'utf8'));
    if (
      !bytes.length ||
      bytes.length > 20 * 1024 * 1024 ||
      assets.reduce((sum, asset) => sum + Buffer.from(asset.data, 'base64').length, 0) + bytes.length > 24 * 1024 * 1024
    )
      throw Error('Soubory překročily povolenou velikost.');
    binary[target] = bytes;
    files[target] = binaryAsset(target) ? '[Binary content asset]' : bytes.toString('utf8');
    assets.push({ ...item, data: bytes.toString('base64') });
  }
}
