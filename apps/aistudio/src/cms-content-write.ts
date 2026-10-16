import { workingContentRevision } from '../../../packages/content/working-revision.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalized = (value: any): any =>
  Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, normalized(value[key])]),
        )
      : value;
const canonical = (value: any) => JSON.stringify(normalized(value));
export async function contentBaseline(source: any) {
  if (source?.context.readOnly !== false) return null;
  const root = process.env.SITETILLER_CMS_ROOT;
  if (!root) throw Error('Editor obsahu není připojen.');
  const schema = await readFile(join(root, 'schema/structure.json'), 'utf8');
  const parsed = JSON.parse(schema);
  delete parsed.settings;
  if (canonical(parsed) !== canonical(source.context.schema))
    throw Error('Struktura se mezitím změnila. Zopakujte požadavek.');
  const revisions: Record<string, string> = {};
  for (const name of Object.keys(source.context.collections)) {
    let text;
    try {
      text = await readFile(join(root, 'data', name + '.json'), 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      text = '[]\n';
    }
    if (canonical(JSON.parse(text)) !== canonical(JSON.parse(source.files['site/cms/data/' + name + '.json'])))
      throw Error('Obsah se mezitím změnil. Zopakujte požadavek.');
    revisions[name] = hash(text);
  }
  const contentRevision = await workingContentRevision(root).catch((e: any) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (source.workingRevision && source.workingRevision !== contentRevision)
    throw Error('Pracovní obsah se mezitím změnil. Zopakujte požadavek.');
  return {
    schema: parsed,
    schemaRevision: hash(schema),
    contentRevision,
    schemaWritable:
      source.context.sourceMode === 'unpublished' &&
      source.context.permissions?.schema === 'write' &&
      !!source.historySource &&
      !source.historySource.publishedLayout &&
      resolve(source.historySource.root) === resolve(root),
    revisions,
    files: { ...source.files },
  };
}
export async function contentRequest(path: string, body: any, fetcher = fetch) {
  const origin = process.env.SITETILLER_CMS_URL || 'http://127.0.0.1:4310';
  const bootstrap = await fetcher(origin + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
  if (!bootstrap.ok) throw Error('Editor obsahu není dostupný.');
  const state = await bootstrap.json();
  const response = await fetcher(origin + path, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'x-cms-token': state.token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || 'Změny obsahu se nepodařilo uložit.'), { status: response.status });
  return result;
}

const schemaValue = (value: any) => ({ ...value, version: 0 });
export function normalizeContentPlan(files: Record<string, string>, result: any) {
  if (!result) return;
  if (result.schema) {
    files['site/cms/structure.json'] = JSON.stringify(result.schema, null, 2);
    const rows =
      result.collections ||
      Object.fromEntries(Object.entries(result.lists || {}).map(([name, value]: [string, any]) => [name, value.rows]));
    for (const path of Object.keys(files))
      if (path.startsWith('site/cms/data/') && !Object.hasOwn(result.schema.lists, path.slice(14, -5)))
        delete files[path];
    for (const [name, values] of Object.entries(rows))
      files['site/cms/data/' + name + '.json'] = JSON.stringify(values, null, 2);
    if (files['site/cms/snapshot.json']) {
      const snapshot = JSON.parse(files['site/cms/snapshot.json']);
      snapshot.assets = Object.fromEntries(
        Object.entries(snapshot.assets || {}).filter(([ref]) =>
          Object.hasOwn(result.schema.folders, ref.split('/')[0]),
        ),
      );
      files['site/cms/snapshot.json'] = JSON.stringify(snapshot, null, 2);
    }
  } else
    for (const [name, value] of Object.entries(result.lists || {}) as [string, any][]) {
      if (value.rows) files['site/cms/data/' + name + '.json'] = JSON.stringify(value.rows, null, 2);
    }
}
export async function applyDesignContent(
  baseline: any,
  files: Record<string, string>,
  dryRun: boolean,
  assets: any[] = [],
) {
  if (!baseline) return null;
  const currentSchema =
      baseline.schema ||
      (baseline.files['site/cms/structure.json'] ? JSON.parse(baseline.files['site/cms/structure.json']) : null),
    candidate = files['site/cms/structure.json'] ? JSON.parse(files['site/cms/structure.json']) : currentSchema,
    schemaChanged =
      currentSchema && JSON.stringify(schemaValue(candidate)) !== JSON.stringify(schemaValue(currentSchema));
  if (schemaChanged && !baseline.schemaWritable) throw Error('Struktura vybraného obsahu je pouze pro čtení.');
  if (!schemaChanged && currentSchema) files['site/cms/structure.json'] = JSON.stringify(currentSchema, null, 2);
  const names = schemaChanged ? Object.keys(candidate.lists) : Object.keys(baseline.revisions);
  const changes = names
    .filter(
      (name) =>
        canonical(JSON.parse(files['site/cms/data/' + name + '.json'] || '[]')) !==
        canonical(JSON.parse(baseline.files['site/cms/data/' + name + '.json'] || '[]')),
    )
    .map((collection) => ({
      collection,
      revision: baseline.revisions[collection] || hash('[]\n'),
      rows: JSON.parse(files['site/cms/data/' + collection + '.json'] || '[]'),
    }));
  if (!schemaChanged && !changes.length && !assets.length) {
    if (currentSchema && candidate) files['site/cms/structure.json'] = JSON.stringify(currentSchema, null, 2);
    return null;
  }
  const payload = {
    schemaRevision: baseline.schemaRevision,
    changes,
    dryRun,
    ...(assets.length ? { assets: assets.map(({ folder, name, data }) => ({ folder, name, data })) } : {}),
  };
  if (schemaChanged) {
    if (!/^[a-f0-9]{64}$/.test(baseline.contentRevision || ''))
      throw Error('Chybí revize pracovního obsahu pro úpravu struktury.');
    return contentRequest('/api/design-structure', {
      ...payload,
      schema: candidate,
      expectedRevision: baseline.contentRevision,
    });
  }
  return contentRequest('/api/design-content', payload);
}
