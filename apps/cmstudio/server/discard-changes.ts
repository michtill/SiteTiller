import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, Problem, type Row } from './store.ts';
import { Publication } from './publication.ts';
import { restoreDesignContent } from './design-restore.ts';
export async function discardChanges(
  store: Store,
  publication: Publication,
  input: unknown,
  onCommitted?: () => Promise<unknown>,
) {
  const body = input as { confirm: boolean; expectedRevision: string };
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['confirm', 'expectedRevision'].includes(k)) ||
    body.confirm !== true ||
    typeof body.expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.expectedRevision)
  )
    throw new Problem(422, 'Potvrďte odstranění úprav a znovu načtěte aktuální stav.');
  const snapshot = await store.exclusive(async () => ({
    published: await publication.syncProduction(),
    production: await publication.production(),
  }));
  if (!snapshot.published) throw new Problem(409, 'Zatím neexistuje publikovaná verze obsahu.');
  const base = snapshot.published.directory,
    schema = JSON.parse(await readFile(join(base, 'schema/structure.json'), 'utf8')),
    collections: Record<string, Row[]> = {},
    linked: Record<string, string> = {};
  for (const name of Object.keys(schema.lists))
    collections[name] = JSON.parse(await readFile(join(base, 'data', name + '.json'), 'utf8'));
  const walk = async (folder: string, path: string, prefix = '') => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Problem(422, 'Publikovaný soubor je symbolický odkaz.');
      if (item.isDirectory()) await walk(folder, join(path, item.name), prefix + item.name + '/');
      else if (item.isFile()) linked[folder + '/' + prefix + item.name] = join(path, item.name);
    }
  };
  for (const folder of Object.keys(schema.folders || {})) {
    try {
      await walk(folder, join(base, 'media', folder));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  // Published files are linked into the working content directly: no base64 transfer, no size limit.
  return restoreDesignContent(
    store,
    { schema, collections, assets: [], expectedRevision: body.expectedRevision, dryRun: false },
    async () => {
      const now = await publication.production();
      if (JSON.stringify(now) !== JSON.stringify(snapshot.production))
        throw new Problem(409, 'Publikovaná verze se mezitím změnila. Znovu otevřete odstranění úprav.');
      if (onCommitted) await onCommitted();
    },
    undefined,
    false,
    linked,
  );
}
