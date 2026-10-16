import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function localProductionState(root: string) {
  try {
    return JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
