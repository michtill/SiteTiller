import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Cheap fingerprint of everything a live preview shows from the content editor: working schema/rows,
// the media listing (path, size, time) and both publication pointers. Read on every /api/state.
export async function contentSignature() {
  const root = process.env.SITETILLER_CMS_ROOT;
  if (!root) return null;
  const hash = createHash('sha256');
  const add = async (label: string, path: string) => {
    hash.update(label + '\0');
    try {
      hash.update(await readFile(path));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      hash.update('missing');
    }
  };
  await add('schema', join(root, 'schema/structure.json'));
  for (const name of (await readdir(join(root, 'data')).catch(() => [] as string[])).sort())
    if (name.endsWith('.json')) await add('data/' + name, join(root, 'data', name));
  const walk = async (path: string) => {
    for (const name of (await readdir(join(root, path)).catch(() => [] as string[])).sort()) {
      const info = await lstat(join(root, path, name));
      if (info.isDirectory()) await walk(path + '/' + name);
      else hash.update(path + '/' + name + '\0' + info.size + '\0' + info.mtimeMs + '\0');
    }
  };
  await walk('media');
  await add('cms-publication', join(root, '.cms-publication/current.json'));
  const production = process.env.SITETILLER_PRODUCTION_DIRECTORY || process.env.SITETILLER_LOCAL_PRODUCTION_ROOT;
  if (production) await add('production', join(production, 'current.json'));
  return hash.digest('hex').slice(0, 32);
}
