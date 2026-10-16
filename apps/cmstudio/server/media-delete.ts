import { join } from 'node:path';
import { lstat, copyFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store, Problem } from './store.ts';
import { fileInFolder } from '../file-field.ts';
async function checkedPath(store: Store, path: string) {
  const schema = await store.schema(),
    parts = path.split('/');
  if (
    parts.length < 2 ||
    parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) ||
    !Object.hasOwn(schema.folders || {}, parts[0])
  )
    throw new Problem(422, 'Neplatná cesta souboru.');
  let target = join(store.root, 'media');
  if ((await lstat(target)).isSymbolicLink()) throw new Problem(422, 'Symbolická složka není povolena.');
  for (const p of parts) {
    target = join(target, p);
    if ((await lstat(target)).isSymbolicLink()) throw new Problem(422, 'Symbolický odkaz nelze odstranit.');
  }
  if (!(await lstat(target)).isFile()) throw new Problem(422, 'Vyberte soubor.');
  return { target, schema, folder: parts[0] };
}
export async function mediaUsage(store: Store, path: string) {
  const { schema, folder } = await checkedPath(store, path),
    usage: { collection: string; record: string; field: string }[] = [];
  const normalize = (value: string) => {
    try {
      const clean = decodeURIComponent(value.replace(/&amp;/g, '&').split(/[?#]/)[0]);
      return fileInFolder(/^https?:\/\//i.test(clean) ? new URL(clean).pathname : clean, folder);
    } catch {
      return null;
    }
  };
  for (const [name, def] of Object.entries(schema.lists))
    for (const row of (await store.snapshot(name)).rows)
      for (const [key, field] of Object.entries(def.columns)) {
        const value = row[key] || '',
          candidates = [
            value,
            ...[...value.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
            ...[...value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1]),
            // Markdown links and images: [text](path) / ![alt](path "title")
            ...[...value.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
          ];
        if (candidates.some((v) => normalize(v.trim()) === path)) {
          const display = Array.isArray(def.display)
            ? def.display
            : typeof def.display === 'string'
              ? [def.display]
              : [def.key];
          usage.push({
            collection: def.label,
            record:
              display
                .map((k) => row[k])
                .filter(Boolean)
                .join(' · ') || row[def.key],
            field: field.label,
          });
        }
      }
  return usage;
}
export function deleteMedia(store: Store, path: string) {
  return store.exclusive(async () => {
    const usage = await mediaUsage(store, path);
    if (usage.length)
      throw new Problem(
        409,
        'Soubor nelze odstranit. Je použit: ' +
          usage.map((u) => u.collection + ' / ' + u.record + ' / ' + u.field).join('; '),
      );
    const { target } = await checkedPath(store, path),
      backup = join(store.root, 'backups', 'deleted-files');
    await mkdir(backup, { recursive: true });
    await copyFile(target, join(backup, randomUUID() + '-' + path.split('/').at(-1)));
    await unlink(target);
    return { deleted: path };
  });
}
