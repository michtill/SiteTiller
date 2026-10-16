import { join } from 'node:path';
import { pruneNewest } from '../../../packages/content/files.mjs';
// Retention of private Editor backups: 200 newest per-write backups and 3 newest restore backups
// (the latter hold complete media copies). Called after a successful write; transient files are never touched.
export async function pruneBackups(root: string) {
  const directory = join(root, 'backups');
  await pruneNewest(directory, { keep: 200, filter: (name) => /^\d+-.+\.json$/.test(name) });
  await pruneNewest(directory, { keep: 3, filter: (name) => /^restore-[0-9a-f-]{36}$/.test(name) });
}
