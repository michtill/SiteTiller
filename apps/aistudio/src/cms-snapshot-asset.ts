import { createHash } from 'node:crypto';
import { extname } from 'node:path';
// Resolve runtime CMS asset URLs against the frozen, host-managed job snapshot.
export function cmsSnapshotAsset(relative: string, files: Record<string, string>) {
  if (!relative.startsWith('cms/files/')) return null;
  const source = relative.slice(10),
    parts = source.split('/');
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) return null;
  let schema;
  try {
    schema = JSON.parse(files['site/cms/structure.json']);
  } catch {
    return null;
  }
  if (!Object.hasOwn(schema.folders || {}, parts[0])) return null;
  try {
    const snapshot = JSON.parse(files['site/cms/snapshot.json'] || 'null'),
      target = snapshot?.assets?.[source];
    if (
      typeof target === 'string' &&
      Object.hasOwn(files, target) &&
      /^site\/cms\/(?:media|files)\/[a-zA-Z0-9_./-]+$/.test(target) &&
      !target.split('/').some((part) => part === '.' || part === '..')
    )
      return target;
  } catch {}
  const extension = extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return null;
  const path = 'site/cms/media/' + createHash('sha256').update(source).digest('hex').slice(0, 16) + extension;
  return Object.hasOwn(files, path) ? path : null;
}
