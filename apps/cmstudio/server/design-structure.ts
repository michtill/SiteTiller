import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store, Problem, type Schema, type Row } from './store.ts';
import { prepareStructure, schemaSnapshot } from './structure.ts';
import { prepareDesignContent, commitWorkingTransaction } from './design-content.ts';
import { restoreRevision } from './design-restore.ts';
import { pruneBackups } from './backups.ts';
export function writeDesignStructure(store: Store, input: unknown, onCommitted?: () => Promise<unknown>) {
  return store.exclusive(async () => {
    const body = input as {
      schema: Schema;
      schemaRevision: string;
      expectedRevision: string;
      dryRun?: boolean;
      changes?: { collection: string; rows: Row[]; revision: string }[];
      assets?: { folder: string; name: string; data: string }[];
    };
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !['schema', 'schemaRevision', 'expectedRevision', 'dryRun', 'changes', 'assets'].includes(k),
      ) ||
      typeof body.schemaRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.schemaRevision) ||
      typeof body.expectedRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.expectedRevision) ||
      (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') ||
      (body.changes !== undefined && (!Array.isArray(body.changes) || body.changes.length > 100)) ||
      (body.assets !== undefined && (!Array.isArray(body.assets) || body.assets.length > 100))
    )
      throw new Problem(422, 'Neplatný požadavek na úpravu struktury.');
    const check = async () => {
      if (body.expectedRevision !== (await restoreRevision(store.root)))
        throw new Problem(409, 'Pracovní obsah se mezitím změnil. Znovu načtěte podklady.');
    };
    await check();
    const proposedRows: Record<string, Row[]> = {};
    for (const change of body.changes || []) {
      if (
        !change ||
        typeof change !== 'object' ||
        typeof change.collection !== 'string' ||
        !Array.isArray(change.rows) ||
        Object.hasOwn(proposedRows, change.collection)
      )
        throw new Problem(422, 'Neplatná nebo opakovaná kolekce.');
      proposedRows[change.collection] = change.rows;
    }
    const proposedAssets = new Set<string>();
    for (const asset of body.assets || []) {
      if (!asset || typeof asset.folder !== 'string' || typeof asset.name !== 'string')
        throw new Problem(422, 'Neplatný soubor.');
      proposedAssets.add(asset.folder + '/' + asset.name);
    }
    const { old, schema, planned, sequenceWrites } = await prepareStructure(store, body.schema, body.schemaRevision, {
      rows: proposedRows,
      assets: proposedAssets,
    });
    const current = await store.all(),
      candidate = new Store(store.root);
    candidate.schema = async () => schema;
    const baselines = Object.fromEntries(
      Object.keys(schema.lists).map((name) => [
        name,
        { rows: planned[name], revision: current[name]?.revision || createHash('sha256').update('[]\n').digest('hex') },
      ]),
    );
    let assets: Record<string, Buffer> = {},
      finalRows: Record<string, Row[]> = { ...planned };
    if (body.changes?.length || body.assets?.length) {
      const proposal = await prepareDesignContent(
        candidate,
        {
          schemaRevision: body.schemaRevision,
          changes: (body.changes || []).map((change) => ({
            ...change,
            rows: planned[change.collection] || change.rows,
          })),
          assets: body.assets || [],
          dryRun: true,
        },
        { schema, current: baselines, skipGeneration: true },
      );
      assets = proposal.assets;
      finalRows = { ...finalRows, ...proposal.validated };
    }
    // Revalidate the complete final graph (including untouched migrated collections).
    const validated: Record<string, Row[]> = {};
    for (const name of Object.keys(schema.lists))
      validated[name] = await candidate.validateRows(name, finalRows[name], finalRows, new Set(Object.keys(assets)));
    const schemaChanged = JSON.stringify({ ...schema, version: old.schema.version }) !== JSON.stringify(old.schema);
    schema.version = old.schema.version + (schemaChanged ? 1 : 0);
    await check();
    if (body.dryRun)
      return {
        dryRun: true,
        validated: true,
        schema,
        schemaRevision: old.revision,
        collections: validated,
        contentRevision: body.expectedRevision,
      };
    const writes: Record<string, string> = { ...sequenceWrites };
    if (schemaChanged) writes['schema/structure.json'] = JSON.stringify(schema, null, 2) + '\n';
    for (const [name, rows] of Object.entries(validated))
      if (!Object.hasOwn(old.schema.lists, name) || JSON.stringify(rows) !== JSON.stringify(current[name]?.rows))
        writes['data/' + name + '.json'] = JSON.stringify(rows, null, 2) + '\n';
    if (!Object.keys(writes).length && !Object.keys(assets).length)
      return {
        changed: false,
        schema: old.schema,
        schemaRevision: old.revision,
        lists: await store.all(),
        contentRevision: body.expectedRevision,
      };
    const before: Record<string, string | null> = {};
    for (const path of Object.keys(writes)) {
      try {
        before[path] = await readFile(join(store.root, path), 'utf8');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        before[path] = null;
      }
    }
    await mkdir(join(store.root, 'data'), { recursive: true });
    await mkdir(join(store.root, 'backups'), { recursive: true });
    await writeFile(
      join(store.root, 'backups', Date.now() + '-design-structure-' + randomUUID() + '.json'),
      JSON.stringify({ schema: old.schema, before }, null, 2) + '\n',
    );
    await check();
    await commitWorkingTransaction(store.root, writes, before, undefined, onCommitted, assets, true);
    await pruneBackups(store.root).catch(() => {});
    const after = await schemaSnapshot(store.root);
    return {
      changed: true,
      schema: after.schema,
      schemaRevision: after.revision,
      lists: await store.all(),
      contentRevision: await restoreRevision(store.root),
    };
  });
}
