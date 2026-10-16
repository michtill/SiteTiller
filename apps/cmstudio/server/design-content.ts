import { readSequences, planGeneratedRows, sequenceWrite } from './generated-values.ts';
import { commitWorkingTransaction } from './working-transaction.ts';
import { readFile, writeFile, mkdir, rename, unlink, lstat, link } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadName, folderMaxBytes } from './file-upload.ts';
import { randomUUID } from 'node:crypto';
import { Store, Problem, type Row } from './store.ts';
import { schemaSnapshot, recoverStructure } from './structure.ts';
import { pruneBackups } from './backups.ts';
export type DesignContentInput = {
  schemaRevision: string;
  dryRun?: boolean;
  assets?: { folder: string; name: string; data: string }[];
  changes: { collection: string; rows: Row[]; revision: string }[];
};
import { atomicWrite as atomic } from '../../../packages/content/files.mjs';
// Working content only. Publication and editor afterSave are deliberately not invoked.
export async function prepareDesignContent(
  store: Store,
  input: unknown,
  options: {
    schema?: import('./store.ts').Schema;
    current?: Record<string, { rows: Row[]; revision: string }>;
    skipGeneration?: boolean;
  } = {},
) {
  const body = input as DesignContentInput;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['schemaRevision', 'changes', 'dryRun', 'assets'].includes(k)) ||
    (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') ||
    typeof body.schemaRevision !== 'string' ||
    !Array.isArray(body.changes) ||
    body.changes.length > 100 ||
    (body.assets !== undefined && !Array.isArray(body.assets)) ||
    (!body.changes.length && !body.assets?.length) ||
    (body.assets?.length ?? 0) > 100
  )
    throw new Problem(422, 'Neplatný požadavek na úpravu obsahu.');
  const snapshot = await schemaSnapshot(store.root),
    schema = { ...snapshot, schema: options.schema || snapshot.schema };
  if (body.schemaRevision !== schema.revision) throw new Problem(409, 'Struktura se změnila. Znovu načtěte podklady.');
  const assets: Record<string, Buffer> = {},
    assetNames = new Set<string>();
  let assetBytes = 0;
  for (const asset of body.assets || []) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      Object.keys(asset).some((k) => !['folder', 'name', 'data'].includes(k)) ||
      typeof asset.folder !== 'string' ||
      !/^[\w-]+$/.test(asset.folder) ||
      !Object.hasOwn(schema.schema.folders || {}, asset.folder) ||
      typeof asset.name !== 'string' ||
      typeof asset.data !== 'string'
    )
      throw new Problem(422, 'Neplatný soubor nebo složka.');
    uploadName(schema.schema.folders![asset.folder].type, asset.name);
    const path = asset.folder + '/' + asset.name,
      key = path.toLowerCase();
    if (assetNames.has(key)) throw new Problem(422, 'Soubor je v dávce opakovaný.');
    assetNames.add(key);
    if (
      !asset.data.length ||
      asset.data.length > Math.ceil(folderMaxBytes(schema.schema.folders![asset.folder]) / 3) * 4 ||
      asset.data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)
    )
      throw new Problem(422, 'Neplatná base64 data souboru.');
    const bytes = Buffer.from(asset.data, 'base64');
    if (bytes.toString('base64') !== asset.data || bytes.length > folderMaxBytes(schema.schema.folders![asset.folder]))
      throw new Problem(422, 'Neplatná base64 data nebo příliš velký soubor.');
    assetBytes += bytes.length;
    if (assetBytes > 25 * 1024 * 1024) throw new Problem(413, 'Soubory v dávce překročily celkový limit.');
    for (const dir of ['media', 'media/' + asset.folder]) {
      try {
        const stat = await lstat(join(store.root, dir));
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Problem(422, 'Neplatná složka souborů.');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    try {
      await lstat(join(store.root, 'media', path));
      throw new Problem(409, 'Soubor již existuje. Přepsání není povoleno.');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    assets[path] = bytes;
  }
  const current = options.current || ((await store.all()) as Record<string, { rows: Row[]; revision: string }>),
    planned: Record<string, Row[]> = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.rows])),
    names = new Set<string>();
  for (const change of body.changes) {
    if (
      !change ||
      typeof change !== 'object' ||
      Object.keys(change).some((k) => !['collection', 'rows', 'revision'].includes(k)) ||
      typeof change.collection !== 'string' ||
      !Object.hasOwn(schema.schema.lists, change.collection) ||
      names.has(change.collection) ||
      !Array.isArray(change.rows)
    )
      throw new Problem(422, 'Neplatná nebo opakovaná kolekce.');
    names.add(change.collection);
    if (change.revision !== current[change.collection].revision)
      throw new Problem(409, 'Obsah se mezitím změnil. Znovu načtěte podklady.');
    planned[change.collection] = change.rows;
  }
  const sequences = await readSequences(store.root);
  let sequenceWrites: Record<string, string> = {};
  if (!options.skipGeneration) {
    const generation = planGeneratedRows(
      schema.schema,
      planned,
      schema.schema,
      Object.fromEntries(Object.entries(current).map(([name, value]) => [name, value.rows])),
      sequences.state,
    );
    Object.assign(planned, generation.rows);
    sequenceWrites = sequenceWrite(sequences.state, generation.state);
  }
  const validated: Record<string, Row[]> = {};
  for (const name of names)
    validated[name] = await store.validateRows(name, planned[name], planned, new Set(Object.keys(assets)));
  return { body, schema, assets, current, validated, names, sequenceWrites };
}
export function writeDesignContent(store: Store, input: unknown, onCommitted?: () => Promise<unknown>) {
  return store.exclusive(async () => {
    const { body, schema, assets, current, validated, names, sequenceWrites } = await prepareDesignContent(
      store,
      input,
    );
    if (body.dryRun)
      return {
        schemaRevision: schema.revision,
        dryRun: true,
        validated: true,
        assets: Object.keys(assets),
        lists: Object.fromEntries(
          [...names].map((name) => [name, { rows: validated[name], revision: current[name].revision }]),
        ),
      };
    const semantic = (rows: Row[]) =>
      JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(
            Object.keys(row)
              .sort()
              .map((key) => [key, row[key]]),
          ),
        ),
      );
    const changed = [...names].filter((name) => semantic(validated[name]) !== semantic(current[name].rows));
    if (!changed.length && !Object.keys(assets).length)
      return {
        schemaRevision: schema.revision,
        changed: false,
        lists: Object.fromEntries([...names].map((name) => [name, current[name]])),
      };
    const before: Record<string, string | null> = {},
      writes: Record<string, string> = { ...sequenceWrites };
    for (const name of changed) {
      const path = 'data/' + name + '.json';
      try {
        before[path] = await readFile(join(store.root, path), 'utf8');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        before[path] = null;
      }
      writes[path] = JSON.stringify(validated[name], null, 2) + '\n';
    }
    for (const path of Object.keys(sequenceWrites)) {
      try {
        before[path] = await readFile(join(store.root, path), 'utf8');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        before[path] = null;
      }
    }
    await mkdir(join(store.root, 'backups'), { recursive: true });
    await mkdir(join(store.root, 'data'), { recursive: true });
    const backup = join(store.root, 'backups', Date.now() + '-design-content-' + randomUUID() + '.json');
    await writeFile(backup, JSON.stringify({ schemaRevision: schema.revision, before }, null, 2) + '\n');
    await commitWorkingTransaction(store.root, writes, before, atomic, onCommitted, assets);
    await pruneBackups(store.root).catch(() => {});
    return {
      schemaRevision: schema.revision,
      assets: Object.keys(assets),
      lists: Object.fromEntries(await Promise.all([...names].map(async (name) => [name, await store.snapshot(name)]))),
    };
  });
}

export { commitWorkingTransaction } from './working-transaction.ts';
