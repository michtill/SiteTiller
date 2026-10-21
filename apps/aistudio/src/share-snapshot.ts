import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../../../packages/settings/index.mjs';
import { Problem } from './problem.ts';
import { Project } from './project.ts';
import { freezeStep, savedDraft, savedDrafts } from './saved-drafts.ts';
import { productionProject } from './production-history.ts';
// A shared preview (documentation 4.10) shows one frozen state: a step with its content, a saved draft or a published
// version. The commit is pinned by refs/sitetiller/shares/<id>; .sitetiller/share-snapshots.json remembers what was
// shared. A link to a step or saved draft lives only while that step or draft exists; a version's link stays.
// The Shell keeps the links themselves; this only freezes, pins and answers what is still alive.
type Snapshot = {
  commit: string;
  kind: 'step' | 'draft' | 'release';
  stepId?: string | null;
  draftId?: string;
  releaseId?: string;
};
const shareRef = (id: unknown) => {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Problem(422, 'Neplatné sdílení.');
  return 'refs/sitetiller/shares/' + id;
};
const catalog = (project: Project) => join(project.root, '..', 'share-snapshots.json');
async function snapshots(project: Project): Promise<Record<string, Snapshot>> {
  try {
    return JSON.parse(await readFile(catalog(project), 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return {};
  }
}
let writes: Promise<unknown> = Promise.resolve();
function change(project: Project, fn: (all: Record<string, Snapshot>) => void) {
  const run = writes.then(async () => {
    const all = await snapshots(project);
    fn(all);
    await atomicJson(catalog(project), all);
  });
  writes = run.catch(() => {});
  return run;
}
export async function shareSnapshot(project: Project, config: any, input: any) {
  const ref = shareRef(input.id);
  let snapshot: Snapshot, label: string;
  if (input.kind === 'step') {
    const head = await project.head(),
      request = input.stepId
        ? (config.requests || []).find((r: any) => r.id === input.stepId && ['ready', 'legacy'].includes(r.status))
        : (config.requests || []).findLast(
            (r: any) => r.commit === (input.commit || head) && ['ready', 'legacy'].includes(r.status),
          ),
      target = request?.commit || input.commit || head;
    if (input.stepId && !request) throw new Problem(404, 'Krok neexistuje.');
    if (target !== head && !request) throw new Problem(404, 'Krok neexistuje.');
    const frozen = await freezeStep(project, {
      expectedHead: head,
      commit: target,
      ...(target === head && process.env.SITETILLER_CMS_ROOT ? { cmsSource: 'unpublished' } : {}),
    });
    snapshot = { commit: frozen.snapshot, kind: 'step', stepId: request?.id || null };
    label = request ? 'Krok ' + request.sequence : 'Aktuální návrh';
  } else if (input.kind === 'draft') {
    let record;
    try {
      record = await savedDraft(project, input.draftId);
    } catch (e: any) {
      throw new Problem(404, e.message);
    }
    snapshot = { commit: record.commit, kind: 'draft', draftId: record.id };
    label = 'Uložený návrh ' + record.name;
  } else if (input.kind === 'release') {
    const release = (config.releases || []).find((r: any) => r.id === input.releaseId);
    if (!release) throw new Problem(404, 'Verze neexistuje.');
    try {
      await project.git(['cat-file', '-e', release.commit + '^{commit}']);
    } catch {
      const production = productionProject();
      if (!production) throw new Problem(404, 'Verze není dostupná.');
      await project.git(['fetch', '--no-tags', production.root, release.commit]);
    }
    snapshot = { commit: release.commit, kind: 'release', releaseId: release.id };
    label = 'Verze ' + release.number + (release.minor !== undefined ? '.' + release.minor : '');
  } else throw new Problem(422, 'Sdílet lze krok, uložený návrh nebo verzi.');
  await project.git(['update-ref', ref, snapshot.commit]);
  await change(project, (all) => {
    all[input.id] = snapshot;
  });
  return { label, stepId: snapshot.stepId ?? null };
}
export async function removeShareSnapshot(project: Project, id: unknown) {
  const ref = shareRef(id);
  await project.git(['update-ref', '-d', ref]).catch(() => {});
  await change(project, (all) => {
    delete all[id as string];
  });
}
// The shared state of a link while its step or saved draft still exists; null otherwise.
export async function liveSnapshot(project: Project, id: string, config?: any) {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const snapshot = (await snapshots(project))[id];
  if (!snapshot) return null;
  if (snapshot.kind === 'step' && snapshot.stepId) {
    const current = config || JSON.parse(await readFile(join(project.root, '..', 'config.json'), 'utf8'));
    if (!(current.requests || []).some((r: any) => r.id === snapshot.stepId && ['ready', 'legacy'].includes(r.status)))
      return null;
  }
  if (snapshot.kind === 'draft' && !(await savedDrafts(project)).some((d: any) => d.id === snapshot.draftId))
    return null;
  return (await project.resolveRef('refs/sitetiller/shares/' + id)) === snapshot.commit ? snapshot : null;
}
// Of the given links, which still show something; the others lose their pinned state.
export async function aliveShares(project: Project, config: any, ids: unknown) {
  const alive: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) continue;
    if (await liveSnapshot(project, id, config)) alive.push(id);
    else await removeShareSnapshot(project, id);
  }
  return alive;
}
