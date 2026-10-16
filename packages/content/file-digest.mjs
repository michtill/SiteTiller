import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// SHA-256 of a file's bytes, recomputed only when its size or timestamps change.
// Revisions built from these digests are identical to hashing the bytes every time.
const cache = new Map();
export async function fileDigest(path, info) {
  info ??= await stat(path);
  const key = info.size + ':' + info.mtimeMs + ':' + info.ctimeMs,
    hit = cache.get(path);
  if (hit?.key === key) return hit.digest;
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest();
  cache.set(path, { key, digest });
  return digest;
}
