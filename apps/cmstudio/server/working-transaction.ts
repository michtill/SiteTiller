import { writeFile, mkdir, rename, unlink, lstat, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Problem } from './store.ts';
import { recoverStructure } from './structure.ts';
import { atomicWrite as atomic } from '../../../packages/content/files.mjs';
// Injected writer is for fault tests only, never part of the HTTP contract.
export async function commitWorkingTransaction(
  root: string,
  writes: Record<string, string>,
  before: Record<string, string | null>,
  writer = atomic,
  onCommitted?: () => Promise<unknown>,
  newAssets: Record<string, Buffer> = {},
  allowSchema = false,
) {
  for (const path of [...Object.keys(writes), ...Object.keys(before)])
    if (
      !/^data\/[\w-]+\.json$/.test(path) &&
      path !== '.cmstudio-sequences.json' &&
      !(allowSchema && path === 'schema/structure.json')
    )
      throw new Problem(422, 'Transakce smí měnit jen pracovní kolekce.');
  const staged: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(newAssets)) {
    if (!/^[\w-]+\/[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u.test(path) || path.includes('..'))
      throw new Problem(422, 'Neplatná cesta souboru.');
    const target = 'media/' + path,
      temp = 'backups/' + randomUUID() + '-design-asset.tmp';
    await writeFile(join(root, temp), bytes, { flag: 'wx' });
    staged[target] = temp;
  }
  const createdDirs: string[] = [];
  for (const dir of new Set(
    Object.keys(staged).flatMap((target) => ['media', target.split('/').slice(0, 2).join('/')]),
  )) {
    try {
      await lstat(join(root, dir));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      createdDirs.push(dir);
    }
  }
  const journal = join(root, '.structure-transaction.json');
  await atomic(journal, JSON.stringify({ before, assets: staged, createdDirs }));
  try {
    for (const [target, temp] of Object.entries(staged)) {
      await mkdir(join(root, target, '..'), { recursive: true });
      await link(join(root, temp), join(root, target));
    }
    for (const [path, text] of Object.entries(writes)) await writer(join(root, path), text);
    if (onCommitted) await onCommitted();
    await unlink(journal);
    for (const temp of Object.values(staged)) await unlink(join(root, temp)).catch(() => {});
  } catch (e) {
    await recoverStructure(root);
    throw e;
  }
}
