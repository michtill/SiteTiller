import { readFile, lstat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { liveCms } from './cms-live.ts';
export type CmsPreviewMode = 'published' | 'unpublished';
export function cmsPreviewRoute(path: string) {
  const match = path.match(/^sources\/(published|unpublished)\/(.*)$/);
  return {
    mode: match?.[1] as CmsPreviewMode | undefined,
    route: match?.[2] ?? path,
    sourcePrefix: match ? 'sources/' + match[1] + '/' : '',
  };
}
export async function publishedRoot() {
  const direct = process.env.SITETILLER_CMS_PUBLISHED_ROOT;
  if (direct) return { root: resolve(direct), native: true };
  const production = process.env.SITETILLER_PRODUCTION_DIRECTORY;
  if (production) {
    try {
      const state = JSON.parse(await readFile(join(production, 'current.json'), 'utf8'));
      if (typeof state.directory !== 'string') throw Error('Invalid production pointer');
      return { root: join(state.directory, 'cms'), native: false };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { root: join(production, 'current', 'cms'), native: false };
    }
  }
  const cms = process.env.SITETILLER_CMS_ROOT;
  if (cms) {
    const state = JSON.parse(await readFile(join(cms, '.cms-publication', 'current.json'), 'utf8'));
    if (typeof state.directory !== 'string') throw Error('Invalid CMS publication pointer');
    return { root: resolve(state.directory), native: true };
  }
  throw Error('Publikovaný obsah není připojen.');
}
export async function cmsPreviewAvailable() {
  let published = false;
  try {
    const source = await publishedRoot();
    await readFile(join(source.root, source.native ? 'schema/structure.json' : 'structure.json'));
    published = true;
  } catch {}
  return { published, unpublished: !!process.env.SITETILLER_CMS_ROOT };
}
export async function previewCmsFiles(files: Record<string, string>, mode?: CmsPreviewMode) {
  if (mode !== 'published') return files;
  const source = await publishedRoot(),
    schemaText = await readFile(join(source.root, source.native ? 'schema/structure.json' : 'structure.json'), 'utf8'),
    schema = JSON.parse(schemaText);
  delete schema.settings;
  const out = { ...files };
  for (const name of Object.keys(out)) if (name.startsWith('site/cms/')) delete out[name];
  out['site/cms/structure.json'] = JSON.stringify(schema);
  let bytes = Buffer.byteLength(schemaText);
  for (const name of Object.keys(schema.lists || {})) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw Error('Invalid CMS collection');
    let text;
    try {
      text = await readFile(join(source.root, 'data', name + '.json'), 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      text = '[]';
    }
    bytes += Buffer.byteLength(text);
    if (bytes > 2000000) throw Error('CMS preview data exceeds limit');
    if (!Array.isArray(JSON.parse(text))) throw Error('Invalid CMS rows');
    out['site/cms/data/' + name + '.json'] = text;
  }
  return out;
}
const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};
export async function previewCmsAsset(relative: string, mode: CmsPreviewMode) {
  if (!relative.startsWith('cms/')) return null;
  if (mode === 'unpublished') return liveCms(relative);
  const source = await publishedRoot();
  if (source.native) return liveCms(relative, source.root);
  const missing = () => ({ status: 404, mime: 'text/plain', body: Buffer.from('Soubor obsahu nenalezen.') });
  const parts = relative.slice(4).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) return missing();
  const schema = JSON.parse(await readFile(join(source.root, 'structure.json'), 'utf8'));
  delete schema.settings;
  if (relative === 'cms/structure.json')
    return { status: 200, mime: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(schema)) };
  const collection = relative.match(/^cms\/data\/([a-zA-Z][\w-]{0,63})\.json$/);
  if (collection) {
    if (!Object.hasOwn(schema.lists || {}, collection[1])) return missing();
    try {
      return {
        status: 200,
        mime: 'application/json; charset=utf-8',
        body: await readFile(join(source.root, 'data', collection[1] + '.json')),
      };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { status: 200, mime: 'application/json; charset=utf-8', body: Buffer.from('[]') };
    }
  }
  if (
    !(parts[0] === 'files' && parts.length >= 3 && Object.hasOwn(schema.folders || {}, parts[1])) &&
    !(parts[0] === 'media' && parts.length === 2 && /^[a-f0-9]{16}\.(png|jpg|jpeg|webp)$/.test(parts[1]))
  )
    return missing();
  let path = source.root;
  try {
    for (const part of parts) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) return missing();
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return missing();
    return {
      status: 200,
      mime: types[extname(path).toLowerCase()] || 'application/octet-stream',
      body: await readFile(path),
    };
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return missing();
  }
}
