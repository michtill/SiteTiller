import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
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
export async function liveCms(relative: string, root: string | undefined = process.env.SITETILLER_CMS_ROOT) {
  if (!root || !relative.startsWith('cms/')) return null;
  root = resolve(root);
  const missing = () => ({ status: 404, mime: 'text/plain', body: Buffer.from('Soubor obsahu nenalezen.') });
  const schema = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
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
        body: await readFile(join(root, 'data', collection[1] + '.json')),
      };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { status: 200, mime: 'application/json; charset=utf-8', body: Buffer.from('[]') };
    }
  }
  let source = relative.startsWith('cms/files/') ? relative.slice(10) : '';
  const hashed = relative.match(/^cms\/media\/([a-f0-9]{16}\.(?:png|jpg|jpeg|webp))$/);
  if (hashed) {
    const walk = async (dir: string, prefix: string): Promise<string | null> => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (ent.isSymbolicLink()) continue;
        const ref = prefix + ent.name;
        if (ent.isDirectory()) {
          const found = await walk(join(dir, ent.name), ref + '/');
          if (found) return found;
        } else if (
          createHash('sha256').update(ref).digest('hex').slice(0, 16) + extname(ref).toLowerCase() ===
          hashed[1]
        )
          return ref;
      }
      return null;
    };
    for (const folder of Object.keys(schema.folders || {})) {
      if (!/^[a-zA-Z][\w-]{0,63}$/.test(folder)) continue;
      try {
        if ((await lstat(join(root, 'media', folder))).isSymbolicLink()) continue;
        const found = await walk(join(root, 'media', folder), folder + '/');
        if (found) {
          source = found;
          break;
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  if (!source) return missing();
  const parts = source.split('/');
  if (
    parts.length < 2 ||
    parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) ||
    !Object.hasOwn(schema.folders || {}, parts[0])
  )
    return missing();
  let path = join(root, 'media');
  try {
    for (const part of parts) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) return missing();
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return missing();
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
