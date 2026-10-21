import { atomicJson } from '../../../packages/settings/index.mjs';
import { restoredContent } from './restore-content.ts';
import { readFile, writeFile, rename, mkdtemp, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { Project } from './project.ts';
import { captureCmsPublication } from './cms-publication.ts';
import { cmsSource } from './cms-source.ts';
import { publishedRoot } from './cms-preview.ts';
import { workingContentRevision } from '../../../packages/content/working-revision.mjs';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex'),
  catalogPath = (project: Project) => join(project.root, '..', 'saved-drafts.json');
export async function savedDrafts(project: Project) {
  let values: any;
  try {
    values = JSON.parse(await readFile(catalogPath(project), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  if (
    !Array.isArray(values) ||
    values.length > 100 ||
    values.some(
      (d) =>
        !d ||
        !/^draft-[a-f0-9]{32}$/.test(d.id) ||
        !/^refs\/sitetiller\/saved-drafts\/[a-f0-9]{32}$/.test(d.ref) ||
        !/^[a-f0-9]{40}$/.test(d.commit) ||
        typeof d.name !== 'string',
    )
  )
    throw Error('Neplatný seznam uložených návrhů.');
  return values;
}
export async function savedDraft(project: Project, id: string) {
  if (typeof id !== 'string' || !/^draft-[a-f0-9]{32}$/.test(id)) throw Error('Neplatný uložený návrh.');
  const value = (await savedDrafts(project)).find((d) => d.id === id);
  if (!value || (await project.resolveRef(value.ref)) !== value.commit) throw Error('Uložený návrh není dostupný.');
  return value;
}
async function exportedRevision(root: string) {
  const cms = await cmsSource(root, true);
  if (!cms) throw Error('Obsah není dostupný.');
  return hash(
    JSON.stringify([
      cms.files,
      Object.entries(cms.binary)
        .map(([p, b]) => [p, hash(b)])
        .sort(),
    ]),
  );
}
// Freezes a step with its content into a commit of the project (not yet pinned by any ref): the latest step with
// the chosen content source, an older step with the content saved in it. Used by saved drafts and shared previews.
export async function freezeStep(
  project: Project,
  input: { expectedHead: string; cmsSource?: string; commit?: string },
) {
  if ((await project.head()) !== input.expectedHead || (await project.git(['status', '--porcelain', '--', 'site'])))
    throw Error('Návrh se mezitím změnil.');
  if (input.cmsSource && !process.env.SITETILLER_CMS_ROOT) throw Error('Vybraný obsah není připojen.');
  const frozen = !!input.commit && input.commit !== input.expectedHead;
  if (input.commit) {
    if (!/^[a-f0-9]{40}$/.test(input.commit)) throw Error('Neplatný krok.');
    await project.git(['merge-base', '--is-ancestor', input.commit, input.expectedHead]);
  }
  if (frozen && input.cmsSource) throw Error('Historický krok používá uložený obsah.');
  let source: any = null;
  if (!frozen && process.env.SITETILLER_CMS_ROOT) {
    source =
      input.cmsSource === 'published' ? await publishedRoot() : { root: process.env.SITETILLER_CMS_ROOT, native: true };
  }
  const revision = source
      ? source.native
        ? await workingContentRevision(source.root)
        : await exportedRevision(source.root)
      : null,
    schemaRevision = source
      ? hash(await readFile(join(source.root, source.native ? 'schema/structure.json' : 'structure.json')))
      : null;
  const temporary = await mkdtemp(join(tmpdir(), 'sitetiller-saved-draft-'));
  try {
    await cp(project.root, temporary, { recursive: true });
    const draft = new Project(temporary);
    if (frozen) await draft.git(['checkout', '--detach', input.commit!]);
    if (source) await captureCmsPublication(draft, source.root, !source.native);
    const snapshot = await draft.head();
    const hasContent = !!source || Object.hasOwn(await draft.committedFiles(snapshot), 'site/cms/structure.json');
    if (hasContent) await restoredContent(draft, snapshot);
    if (source) {
      if (input.cmsSource === 'published' && (await publishedRoot()).root !== source.root)
        throw Error('Publikovaný zdroj se během ukládání změnil.');
      const after = source.native ? await workingContentRevision(source.root) : await exportedRevision(source.root);
      if (after !== revision) throw Error('Obsah nebo struktura se během ukládání změnily. Uložení zopakujte.');
    }
    if ((await project.head()) !== input.expectedHead || (await project.git(['status', '--porcelain', '--', 'site'])))
      throw Error('Návrh se mezitím změnil.');
    await project.git(['fetch', '--no-tags', temporary, snapshot]);
    return { snapshot, source, revision, schemaRevision, hasContent, frozen };
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
export async function saveNamedDraft(
  project: Project,
  input: { name: string; expectedHead: string; cmsSource?: string; presentationHead?: string; commit?: string },
) {
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.trim().length > 120 ||
    /[\x00-\x1f]/.test(input.name)
  )
    throw Error('Zadejte název návrhu (nejvýše 120 znaků).');
  if (!['published', 'unpublished', undefined].includes(input.cmsSource)) throw Error('Neplatný zdroj obsahu.');
  const list = await savedDrafts(project);
  if (list.length >= 100) throw Error('Lze uložit nejvýše 100 návrhů.');
  const { snapshot, source, revision, schemaRevision, hasContent } = await freezeStep(project, input);
  const id = randomBytes(16).toString('hex'),
    record = {
      id: 'draft-' + id,
      ref: 'refs/sitetiller/saved-drafts/' + id,
      name: input.name.trim(),
      createdAt: new Date().toISOString(),
      commit: snapshot,
      baseCommit: input.expectedHead,
      presentationHead: input.presentationHead || input.expectedHead,
      step: input.commit || input.expectedHead,
      cmsSource: source ? input.cmsSource || 'unpublished' : 'none',
      contentRevision: revision,
      schemaRevision,
      hasContent,
    };
  await project.git(['update-ref', record.ref, snapshot]);
  const path = catalogPath(project),
    temp = path + '.tmp';
  try {
    await writeFile(temp, JSON.stringify([...list, record], null, 2), { mode: 0o600 });
    await rename(temp, path);
  } catch (e) {
    await project.git(['update-ref', '-d', record.ref]);
    throw e;
  }
  return record;
}
// The step a saved draft came from (its badge in the timeline). When the draft history is rebuilt, the step
// follows its new commit; a step that no longer exists keeps the old commit and so shows no badge.
export function savedDraftStep(record: any) {
  return record.step || record.presentationHead;
}
export async function remapSavedDraftSteps(project: Project, mapping: Record<string, string>) {
  // Only the badge depends on it, so a catalog that cannot be read never stops the caller (a publication).
  let list: any[];
  try {
    list = await savedDrafts(project);
  } catch {
    return;
  }
  let changed = false;
  for (const record of list) {
    const next = mapping[savedDraftStep(record)];
    if (next && next !== record.step) {
      record.step = next;
      changed = true;
    }
  }
  if (changed) await atomicJson(catalogPath(project), list);
}
// `checked` is the record the caller already verified for this request, so the draft is not looked up twice.
export async function namedDraftPreview(project: Project, url: URL, checked?: any) {
  const match = url.pathname.match(/^\/preview\/drafts\/(draft-[a-f0-9]{32})\/(.*)$/);
  if (!match) return null;
  const record = checked?.id === match[1] ? checked : await savedDraft(project, match[1]);
  return {
    project,
    commit: record.commit,
    frozen: true,
    cmsMode: undefined,
    relative: decodeURIComponent(match[2].replace(/^access\/[0-9]{13}-[a-f0-9]{64}\//, '')),
    prefix: '/preview/drafts/' + record.id + '/' + (match[2].match(/^access\/[0-9]{13}-[a-f0-9]{64}\//)?.[0] || ''),
  };
}

export async function removeNamedDraft(project: Project, input: { id: string; commit: string; expectedHead: string }) {
  if ((await project.head()) !== input.expectedHead) throw Error('Návrh se mezitím změnil.');
  const record = await savedDraft(project, input.id);
  if (record.commit !== input.commit) throw Error('Uložený návrh se mezitím změnil.');
  const list = await savedDrafts(project),
    path = catalogPath(project);
  await atomicJson(
    path,
    list.filter((d) => d.id !== record.id),
  );
  try {
    await project.git(['update-ref', '-d', record.ref, record.commit]);
  } catch (error) {
    await atomicJson(path, list);
    throw error;
  }
  return { removed: record.id };
}
