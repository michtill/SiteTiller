import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../../src/project.ts';
const root = process.env.SITETILLER_FAULT_DATA_DIR;
if (!root || !resolve(root).startsWith(resolve(tmpdir()) + sep))
  throw Error('Fault injection is restricted to disposable test data');
const git = Project.prototype.git;
Project.prototype.git = async function (args: string[]) {
  if (
    resolve(this.root) === resolve(join(root, 'project')) &&
    args[0] === 'read-tree' &&
    existsSync(join(root, 'fail-read-tree'))
  )
    throw Object.assign(Error('Injected EBUSY workspace update'), { code: 'EBUSY' });
  return git.call(this, args);
};

const rename = fs.promises.rename;
fs.promises.rename = async function (from: any, to: any) {
  if (resolve(String(to)) === resolve(join(root!, 'config.json')) && existsSync(join(root!, 'fail-confirmed-config'))) {
    const value = JSON.parse(await fs.promises.readFile(from, 'utf8'));
    if (value.pendingRelease?.confirmedRelease)
      throw Object.assign(Error('Injected persistent EBUSY confirmed metadata'), { code: 'EBUSY' });
  }
  if (resolve(String(to)) === resolve(join(root!, 'config.json')) && existsSync(join(root!, 'fail-final-config'))) {
    const value = JSON.parse(await fs.promises.readFile(from, 'utf8'));
    if (
      value.pendingRelease === null &&
      value.requests?.length === 0 &&
      value.draftBaseCommit === value.publishedCommit
    ) {
      await fs.promises.unlink(join(root!, 'fail-final-config'));
      throw Object.assign(Error('Injected EBUSY final metadata'), { code: 'EBUSY' });
    }
  }
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
