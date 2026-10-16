import { readFile, writeFile, readdir, lstat, mkdir, rename, rm, unlink } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store, Problem, type Schema, type Row } from './store.ts';
import { fileDigest } from '../../../packages/content/file-digest.mjs';
import { linkOrCopy } from '../../../packages/content/files.mjs';
import { pruneBackups } from './backups.ts';
import { validateStructure, schemaSnapshot } from './structure.ts';
import { uploadName, folderMaxBytes } from './file-upload.ts';
const parts = ['schema', 'data', 'media'] as const;
function managed(root: string, name: string) {
  if (!parts.includes(name as any)) throw Error('Invalid restore directory');
  const path = resolve(root, name),
    rel = relative(resolve(root), path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Invalid restore path');
  return path;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e: any) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
import { atomicWrite as atomic } from '../../../packages/content/files.mjs';
export async function restoreRevision(root: string) {
  const hash = createHash('sha256');
  async function walk(path: string) {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Problem(422, 'Symbolické odkazy nelze obnovovat.');
    if (stat.isDirectory()) {
      hash.update('dir:' + path + '\0');
      for (const item of (await readdir(join(root, path))).sort()) await walk(path + '/' + item);
    } else if (stat.isFile()) {
      hash.update('file:' + path + '\0');
      hash.update(await fileDigest(join(root, path), stat));
    } else throw new Problem(422, 'Neplatný soubor pracovního obsahu.');
  }
  for (const name of parts) await walk(name);
  return hash.digest('hex');
}
export function designRestoreState(store: Store) {
  return store.exclusive(async () => ({ revision: await restoreRevision(store.root) }));
}
export async function recoverDesignRestore(root: string) {
  const path = join(root, '.design-restore-transaction.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(path, 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!/^[a-f0-9-]{36}$/.test(journal.id)) throw Error('Invalid restore journal');
  const backup = resolve(root, 'backups', 'restore-' + journal.id),
    backupRel = relative(resolve(root), backup);
  if (backupRel.startsWith('..') || isAbsolute(backupRel)) throw Error('Invalid cleanup path');
  if (journal.committed === true && journal.discardAfterCommit === true) {
    await rm(backup, { recursive: true, force: true });
    await unlink(path);
    return;
  }
  for (const name of parts) {
    const old = join(backup, 'before', name);
    if (await exists(old)) {
      await rm(managed(root, name), { recursive: true, force: true });
      await rename(old, managed(root, name));
    }
  }
  await unlink(path);
}
// An asset is either base64 data or {folder,name,sha256}: the identical current working file is reused without transfer.
export type DesignRestoreInput = {
  schema: Schema;
  collections: Record<string, Row[]>;
  assets: ({ folder: string; name: string; data: string } | { folder: string; name: string; sha256: string })[];
  expectedRevision: string;
  dryRun: boolean;
};
// linkedSources (internal callers only): asset path -> absolute file already on this disk, staged by hard link.
export function restoreDesignContent(
  store: Store,
  input: unknown,
  onCommitted?: () => Promise<unknown>,
  move = rename,
  keepBackup = true,
  linkedSources: Record<string, string> = {},
) {
  return store.exclusive(async () => {
    const body = input as DesignRestoreInput;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !['schema', 'collections', 'assets', 'expectedRevision', 'dryRun'].includes(k)) ||
      typeof body.expectedRevision !== 'string' ||
      typeof body.dryRun !== 'boolean' ||
      !body.collections ||
      typeof body.collections !== 'object' ||
      Array.isArray(body.collections) ||
      !Array.isArray(body.assets) ||
      body.assets.length > 1000
    )
      throw new Problem(422, 'Neplatný požadavek na obnovu obsahu.');
    if (body.expectedRevision !== (await restoreRevision(store.root)))
      throw new Problem(409, 'Pracovní obsah se mezitím změnil. Znovu otevřete obnovu.');
    const historical = { ...body.schema };
    delete (historical as any).settings;
    const schema = validateStructure(historical),
      collections: Record<string, Row[]> = {};
    if (Object.keys(body.collections).some((name) => !Object.hasOwn(schema.lists, name)))
      throw new Problem(422, 'Historická kolekce není definovaná ve struktuře.');
    for (const name of Object.keys(schema.lists)) {
      if (!Array.isArray(body.collections[name])) throw new Problem(422, 'Chybí historická kolekce ' + name + '.');
      collections[name] = body.collections[name];
    }
    const assets: Record<string, Buffer> = {},
      linked: Record<string, string> = {},
      seen = new Set<string>();
    let total = 0;
    const checkName = (folder: string, name: string) => {
      const segments = name.split('/');
      if (
        segments.some(
          (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part) || /[ .]$/.test(part),
        )
      )
        throw new Problem(422, 'Neplatná cesta historického souboru.');
      for (const part of segments.slice(0, -1)) uploadName('other', part + '.txt');
      uploadName(schema.folders![folder].type, segments.at(-1)!);
      const path = folder + '/' + name;
      if (seen.has(path.toLowerCase())) throw new Problem(422, 'Soubor je v obnově opakovaný.');
      seen.add(path.toLowerCase());
      return path;
    };
    for (const [path, source] of Object.entries(linkedSources)) {
      const [folder, ...rest] = path.split('/');
      if (!Object.hasOwn(schema.folders || {}, folder)) throw new Problem(422, 'Neplatný historický soubor.');
      linked[checkName(folder, rest.join('/'))] = source;
    }
    for (const asset of body.assets as any[]) {
      if (asset && typeof asset === 'object' && typeof asset.sha256 === 'string') {
        if (
          Object.keys(asset).some((k) => !['folder', 'name', 'sha256'].includes(k)) ||
          typeof asset.folder !== 'string' ||
          !Object.hasOwn(schema.folders || {}, asset.folder) ||
          typeof asset.name !== 'string' ||
          !/^[a-f0-9]{64}$/.test(asset.sha256)
        )
          throw new Problem(422, 'Neplatný historický soubor.');
        const path = checkName(asset.folder, asset.name),
          source = join(store.root, 'media', path);
        let digest = '';
        try {
          const info = await lstat(source);
          if (!info.isFile()) throw Error();
          digest = (await fileDigest(source, info)).toString('hex');
        } catch {}
        if (digest !== asset.sha256)
          throw new Problem(409, 'Pracovní soubor ' + path + ' se mezitím změnil. Znovu otevřete obnovu.');
        linked[path] = source;
        continue;
      }
      if (
        !asset ||
        typeof asset !== 'object' ||
        Object.keys(asset).some((k) => !['folder', 'name', 'data'].includes(k)) ||
        typeof asset.folder !== 'string' ||
        !Object.hasOwn(schema.folders || {}, asset.folder) ||
        typeof asset.name !== 'string' ||
        typeof asset.data !== 'string'
      )
        throw new Problem(422, 'Neplatný historický soubor.');
      const path = checkName(asset.folder, asset.name);
      if (
        asset.data.length > Math.ceil(folderMaxBytes(schema.folders![asset.folder]) / 3) * 4 ||
        asset.data.length % 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)
      )
        throw new Problem(422, 'Neplatná base64 data souboru.');
      const bytes = Buffer.from(asset.data, 'base64');
      if (bytes.toString('base64') !== asset.data || bytes.length > folderMaxBytes(schema.folders![asset.folder]))
        throw new Problem(422, 'Neplatná base64 data nebo příliš velký soubor.');
      total += bytes.length;
      if (total > 25 * 1024 * 1024) throw new Problem(413, 'Soubory v obnově překročily celkový limit.');
      assets[path] = bytes;
    }
    const validator = new Store(store.root);
    validator.schema = async () => schema;
    const validated: Record<string, Row[]> = {};
    for (const name of Object.keys(schema.lists))
      validated[name] = await validator.validateRows(
        name,
        collections[name],
        collections,
        new Set([...Object.keys(assets), ...Object.keys(linked)]),
        true,
      );
    if (body.dryRun) return { dryRun: true, validated: true, revision: body.expectedRevision };
    const id = randomUUID(),
      backup = join(store.root, 'backups', 'restore-' + id),
      stage = join(backup, 'stage');
    for (const name of parts) await mkdir(join(stage, name), { recursive: true });
    await mkdir(join(backup, 'before'));
    await writeFile(join(stage, 'schema/structure.json'), JSON.stringify(schema, null, 2) + '\n');
    for (const [name, rows] of Object.entries(validated))
      await writeFile(join(stage, 'data', name + '.json'), JSON.stringify(rows, null, 2) + '\n');
    for (const folder of Object.keys(schema.folders || {}))
      await mkdir(join(stage, 'media', folder), { recursive: true });
    for (const [path, bytes] of Object.entries(assets)) {
      await mkdir(dirname(join(stage, 'media', path)), { recursive: true });
      await writeFile(join(stage, 'media', path), bytes);
    }
    for (const [path, source] of Object.entries(linked)) await linkOrCopy(source, join(stage, 'media', path));
    await writeFile(
      join(backup, 'restore.json'),
      JSON.stringify({ id, expectedRevision: body.expectedRevision }, null, 2) + '\n',
    );
    const journal = join(store.root, '.design-restore-transaction.json');
    await atomic(journal, JSON.stringify({ id }));
    try {
      for (const name of parts) {
        await move(managed(store.root, name), join(backup, 'before', name));
        await move(join(stage, name), managed(store.root, name));
      }
      if (onCommitted) await onCommitted();
      if (keepBackup) await unlink(journal);
      else {
        await atomic(journal, JSON.stringify({ id, committed: true, discardAfterCommit: true }));
        await recoverDesignRestore(store.root);
      }
    } catch (e) {
      await recoverDesignRestore(store.root);
      throw e;
    }
    await pruneBackups(store.root).catch(() => {});
    return {
      restored: true,
      revision: await restoreRevision(store.root),
      ...(keepBackup ? { backup } : {}),
      schemaRevision: (await schemaSnapshot(store.root)).revision,
    };
  });
}
