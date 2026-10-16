import { link, copyFile, mkdir, readdir, stat, rm, open, writeFile, rename, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// The one atomic file write: a unique temp file next to the target, then rename over it; the temp never survives.
export async function atomicWrite(path, data, { mode } = {}) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, data, mode === undefined ? {} : { mode });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
// Cross-process lock: an exclusively created `<path>.lock` file. A lock older than `stale` ms is left over
// from a crashed process and is taken over; otherwise the caller waits up to `wait` ms, then gets ELOCKED.
export async function withFileLock(path, action, { stale = 60000, wait = 30000 } = {}) {
  const lock = path + '.lock',
    deadline = Date.now() + wait;
  await mkdir(dirname(lock), { recursive: true });
  let handle;
  for (;;) {
    try {
      handle = await open(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > stale) {
        await rm(lock, { force: true });
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (Date.now() > deadline) throw Object.assign(Error('Lock is held: ' + lock), { code: 'ELOCKED' });
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    return await action();
  } finally {
    await rm(lock, { force: true });
  }
}
// Published and restored files are never modified in place (new files get new names; deletions unlink),
// so identical files can share storage through hard links. Copy is the fallback where linking is impossible.
export async function linkOrCopy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(source, target);
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    await copyFile(source, target);
  }
}
export async function linkTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Symbolic links are not allowed.');
    const from = join(source, item.name),
      to = join(target, item.name);
    if (item.isDirectory()) await linkTree(from, to);
    else if (item.isFile()) await linkOrCopy(from, to);
  }
}
// Retention: keeps the `keep` newest entries (by modification time) that pass `filter`, never counts or
// deletes `protect`ed paths, and removes the rest. Best effort: a locked entry is left for the next run.
export async function pruneNewest(directory, { keep, protect = [], filter = () => true }) {
  let names;
  try {
    names = await readdir(directory);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const protectedPaths = new Set(protect.filter(Boolean).map((path) => resolve(path))),
    entries = [];
  for (const name of names) {
    if (!filter(name)) continue;
    const path = join(directory, name);
    if (protectedPaths.has(resolve(path))) continue;
    try {
      entries.push({ path, time: (await stat(path)).mtimeMs });
    } catch {}
  }
  entries.sort((a, b) => b.time - a.time);
  const removed = [];
  for (const entry of entries.slice(keep)) {
    try {
      await rm(entry.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed.push(entry.path);
    } catch {}
  }
  return removed;
}
