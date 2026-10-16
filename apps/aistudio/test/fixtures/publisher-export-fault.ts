import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.env.SITETILLER_FAULT_DATA_DIR;
if (!root || !resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error('Disposable fixture only');
const rename = fs.promises.rename;
fs.promises.rename = async function (from: any, to: any) {
  if (String(to) === join(root, 'public/current.json') && fs.existsSync(join(root, 'hold-export')))
    throw Object.assign(Error('Injected export failure'), { code: 'EBUSY' });
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
