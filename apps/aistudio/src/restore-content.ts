import type { Project } from './project.ts';
import { contentRequest } from './cms-content-write.ts';
import { cmsSnapshotAsset } from './cms-snapshot-asset.ts';
import { fileDigest } from '../../../packages/content/file-digest.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export async function restoreContentState() {
  const origin = process.env.SITETILLER_CMS_URL || 'http://127.0.0.1:4310';
  const response = await fetch(origin + '/api/design-restore-state', { signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok || typeof result.revision !== 'string')
    throw Error(result.error || 'Stav pracovního obsahu není dostupný.');
  return result;
}
export async function restoredContent(project: Project, commit: string) {
  const files = await project.committedFiles(commit);
  if (!files['site/cms/structure.json'])
    throw Error('Tato verze neobsahuje uloženou strukturu a obsah. Kompletní obnovení není možné.');
  const schema = JSON.parse(files['site/cms/structure.json']);
  delete schema.settings;
  const collections: Record<string, any> = {};
  for (const name of Object.keys(schema.lists || {})) {
    const text = files['site/cms/data/' + name + '.json'];
    if (text === undefined) throw Error('V této verzi chybí kolekce ' + name + '.');
    collections[name] = JSON.parse(text);
  }
  const mapping: Record<string, string> = {};
  const snapshot = JSON.parse(files['site/cms/snapshot.json'] || 'null');
  for (const [ref, path] of Object.entries(snapshot?.assets || {})) if (typeof path === 'string') mapping[ref] = path;
  for (const path of Object.keys(files)) {
    const match = path.match(/^site\/cms\/files\/(.+)$/);
    if (match && Object.hasOwn(schema.folders || {}, match[1].split('/')[0])) mapping[match[1]] = path;
  }
  if (!snapshot) {
    const strings = (value: any): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : value && typeof value === 'object'
            ? Object.values(value).flatMap(strings)
            : [];
    for (const folder of Object.keys(schema.folders || {})) {
      if (!/^[\w-]+$/.test(folder)) throw Error('Neplatná historická složka.');
      const expression = new RegExp(folder + '/[^\\s"\'<>?#]+', 'g');
      for (const text of strings(collections))
        for (const match of text.matchAll(expression)) {
          const ref = match[0];
          if (mapping[ref]) continue;
          const path = cmsSnapshotAsset('cms/files/' + ref, files);
          if (!path) throw Error('V historické verzi chybí soubor ' + ref + '. Obnovení bylo zastaveno.');
          mapping[ref] = path;
        }
    }
  }
  // A file identical to the current working one is sent as its digest only; the 25 MB limit applies to changed files.
  const workingRoot = process.env.SITETILLER_CMS_ROOT;
  const assets: any[] = [];
  let total = 0;
  for (const [ref, path] of Object.entries(mapping)) {
    const parts = ref.split('/');
    if (
      parts.length !== 2 ||
      !Object.hasOwn(schema.folders || {}, parts[0]) ||
      !Object.hasOwn(files, path) ||
      !path.startsWith('site/cms/')
    )
      throw Error('Neplatná nebo neúplná historická knihovna souborů.');
    const bytes = await project.binary(commit, path),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    if (workingRoot) {
      let working = '';
      try {
        working = (await fileDigest(join(workingRoot, 'media', parts[0], parts[1]))).toString('hex');
      } catch {}
      if (working === sha256) {
        assets.push({ folder: parts[0], name: parts[1], sha256 });
        continue;
      }
    }
    total += bytes.length;
    if (total > 25 * 1024 * 1024) throw Error('Historické soubory překročily limit obnovení 25 MB.');
    assets.push({ folder: parts[0], name: parts[1], data: bytes.toString('base64') });
  }
  return { schema, collections, assets };
}
export async function applyRestoredContent(
  content: Awaited<ReturnType<typeof restoredContent>>,
  revision: string,
  dryRun: boolean,
) {
  return contentRequest('/api/design-restore', { ...content, expectedRevision: revision, dryRun });
}
