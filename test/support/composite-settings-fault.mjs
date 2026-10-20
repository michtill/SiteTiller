import fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.SITETILLER_INSTANCE_ROOT;
if (!root?.includes('example-real-integration-')) throw Error('Fixture only');
const rename = fs.promises.rename;
fs.promises.rename = async function (from, to) {
  if (String(to) === join(root, 'settings/shared.json')) {
    try {
      await readFile(join(root, 'hold-composite-save'));
      await writeFile(join(root, 'composite-entered'), 'fixture');
      for (let i = 0; i < 1000; i++) {
        try {
          await readFile(join(root, 'hold-composite-save'));
        } catch (e) {
          if (e.code === 'ENOENT') break;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Object.assign(Error('Injected shared settings persistence failure'), { status: 503 });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
