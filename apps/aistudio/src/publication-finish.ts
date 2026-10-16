import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './project.ts';
import { rebaseWorkspace } from './workspace-history.ts';
import { productionProject, productionReleases, syncProduction } from './production-history.ts';
import { mapCleanupHistory } from './image-cleanup.ts';
import { closePublishedHistory, publicationClosing } from './publication-history.ts';
import { confirmedPublicationEvidence } from './publication-evidence.ts';
import { atomicJson } from '../../../packages/settings/index.mjs';
import { writeApprovals } from './approvals.ts';
import { remapSavedDraftSteps } from './saved-drafts.ts';
// Commit point is the independently confirmed release. Everything afterward is local replay.
export async function finishConfirmedPublication(project: Project, data: string, config: any, events: any[], job: any) {
  const pending = config.pendingRelease;
  if (!pending?.confirmedRelease) return { config, events, job, completed: false };
  const production = productionProject();
  if (!production) throw Error('Produkční historie není dostupná.');
  const release = (await productionReleases(production)).find(
    (r) =>
      r.commit === pending.confirmedRelease.commit &&
      r.sourceCommit === pending.commit &&
      r.number === pending.number &&
      (r.minor ?? null) === (pending.minor ?? null),
  );
  if (!release) throw Error('Chybí potvrzení stejné publikace.');
  const directory =
      pending.evidence?.directory ||
      join(data, 'publication-recovery', 'internal-' + release.id.replace(/[^\w-]/g, '')),
    path = join(directory, 'finish.json');
  await (await import('node:fs/promises')).mkdir(directory, { recursive: true });
  let journal: any = null;
  try {
    journal = JSON.parse(await readFile(path, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  let head = await project.head();
  let install: any = null;
  try {
    for (const id of (await readdir(join(data, 'workspace-history'))).reverse()) {
      const candidate = JSON.parse(await readFile(join(data, 'workspace-history', id, 'plan.json'), 'utf8'));
      if (candidate.published === release.commit && candidate.selected === pending.commit) {
        if (
          head === candidate.oldHead &&
          (await project.git(['write-tree'])) === (await project.git(['rev-parse', candidate.head + '^{tree}'])) &&
          !(await project.git(['diff', '--name-only'])) &&
          !(await project.git(['ls-files', '--others', '--exclude-standard', '--', 'site']))
        ) {
          await project.git(['update-ref', 'HEAD', candidate.head, head]);
          head = candidate.head;
        }
        try {
          await project.git(['merge-base', '--is-ancestor', candidate.head, head]);
          install = candidate;
          break;
        } catch {}
      }
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  {
    let rebuilt = pending.rebuilt || journal?.rebuilt || install;
    let based = false;
    try {
      await project.git(['merge-base', '--is-ancestor', release.commit, head]);
      based = true;
    } catch {}
    if (based && rebuilt) rebuilt = { ...rebuilt, head };
    else rebuilt = null;
    if (!rebuilt) {
      rebuilt = await rebaseWorkspace(project, production, release.commit, pending.commit);
      pending.rebuilt = rebuilt;
      await confirmedPublicationEvidence(data, pending);
    }
    const next = structuredClone(config);
    let nextEvents = structuredClone(events);
    mapCleanupHistory(next, nextEvents, rebuilt.mapping);
    await syncProduction(next);
    next.pendingRelease = null;
    next.approvedCommit = null;
    next.technicalApproval = null;
    next.reviewedCommits = [];
    next.draftBaseCommit = release.commit;
    next.lastReviewCommit = release.commit;
    next.reviewedThrough = pending.through;
    publicationClosing(next, release.commit, pending.through, pending.clearPrevious !== false);
    next.publishedThrough = pending.through;
    nextEvents = closePublishedHistory(next, nextEvents).events;
    const nextJob = {
      ...job,
      status: 'ready',
      kind: 'publish',
      published: true,
      cleanupPending: false,
      commit: release.commit,
      release,
    };
    delete nextJob.error;
    delete nextJob.warning;
    journal = { head: rebuilt.head, rebuilt, release, config: next, events: nextEvents, job: nextJob };
    await atomicJson(path, journal);
  }
  // Journal is durable before the first metadata write; replay is idempotent after a crash.
  await atomicJson(join(data, 'events.json'), journal.events);
  await atomicJson(join(data, 'config.json'), journal.config, { mode: 0o640 });
  await writeApprovals(data, journal.config);
  await atomicJson(join(data, 'last-job.json'), journal.job);
  // Saved drafts keep their badge on the published step, now the first step of the draft (idempotent on replay).
  await remapSavedDraftSteps(project, journal.rebuilt.mapping);
  await atomicJson(join(data, 'publication-recovery', 'active.json'), { completed: release.commit });
  return { config: journal.config, events: journal.events, job: journal.job, completed: true };
}
export async function recoverablePublication(project: Project, data: string, config: any, events: any[], job: any) {
  await confirmedPublicationEvidence(data, config.pendingRelease);
  return finishConfirmedPublication(project, data, config, events, job);
}
