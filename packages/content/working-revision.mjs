import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileDigest } from './file-digest.mjs';
// CM working-state CAS contract: sorted schema/data/media paths, directory markers and byte hashes.
export async function workingContentRevision(root) {
  const hash = createHash('sha256');
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw Error('Pracovní obsah nesmí obsahovat symbolické odkazy.');
    if (info.isDirectory()) {
      hash.update('dir:' + path + '\0');
      for (const name of (await readdir(join(root, path))).sort()) await walk(path + '/' + name);
    } else if (info.isFile()) {
      hash.update('file:' + path + '\0');
      hash.update(await fileDigest(join(root, path), info));
    } else throw Error('Neplatný soubor pracovního obsahu.');
  }
  for (const path of ['schema', 'data', 'media']) await walk(path);
  return hash.digest('hex');
}
