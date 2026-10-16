import { raster, binaryAsset } from '../src/images.ts';
import { mkdir, writeFile, rename, symlink, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneNewest, atomicWrite, withFileLock } from '../../../packages/content/files.mjs';
const releases = (root) => join(root, 'releases');
export async function prepareSite(project, commit, directory) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid deployment commit');
  const root = resolve(directory),
    releases = join(root, 'releases'),
    target = join(releases, commit);
  await mkdir(releases, { recursive: true });
  let exists = false;
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid deployment directory');
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!exists) {
    const temporary = join(releases, '.stage-' + randomUUID());
    await mkdir(temporary);
    try {
      const files = await project.committedFiles(commit);
      for (const [name, content] of Object.entries(files)) {
        if (!name.startsWith('site/')) continue;
        const path = resolve(temporary, name.slice(5));
        if (!path.startsWith(temporary + '/') && !path.startsWith(temporary + '\\'))
          throw Error('Invalid deployment path');
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, binaryAsset(name) ? await project.binary(commit, name) : content);
      }
      const snapshot = JSON.parse(files['site/cms/snapshot.json'] || 'null'),
        schema = JSON.parse(files['site/cms/structure.json'] || 'null');
      for (const [relative, source] of Object.entries(snapshot?.assets || {})) {
        if (
          relative.split('/').some((part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)) ||
          !Object.hasOwn(schema?.folders || {}, relative.split('/')[0]) ||
          typeof source !== 'string' ||
          !Object.hasOwn(files, source) ||
          !source.startsWith('site/cms/')
        )
          throw Error('Invalid content snapshot asset');
        const path = resolve(temporary, 'cms/files', relative);
        if (!path.startsWith(temporary + '/') && !path.startsWith(temporary + '\\'))
          throw Error('Invalid content snapshot path');
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, await project.binary(commit, source));
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return target;
}
export async function deploySite(project, commit, directory) {
  const root = resolve(directory),
    target = await prepareSite(project, commit, directory);
  // The content editor switches the same pointer; both writers serialize on its lock.
  {
    const pointer = join(root, 'current.json');
    await withFileLock(pointer, () =>
      atomicWrite(
        pointer,
        JSON.stringify({ id: commit, commit, directory: target, publishedAt: new Date().toISOString() }),
      ),
    );
  }
  // Retention: the current release and the ten newest previous ones stay.
  await pruneNewest(releases(root), { keep: 10, protect: [target], filter: (name) => !name.startsWith('.') });
  if (process.platform === 'win32') return target;
  const pointer = join(root, '.current-' + randomUUID());
  await symlink('releases/' + commit, pointer, 'dir');
  try {
    await rename(pointer, join(root, 'current'));
  } finally {
    await rm(pointer, { force: true });
  }
  return target;
}
