import { atomicJson, readJson } from '../../../packages/settings/index.mjs';
import { productionProject, productionReleases } from './production-history.ts';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './project.ts';
export async function publicationEvidence(project: Project, data: string, id: string, config: any, events: any[]) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw Error('Invalid publication ID');
  const head = await project.head(),
    directory = join(data, 'publication-recovery', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(project.root, join(directory, 'workspace-before'), { recursive: true, errorOnExist: true, force: false });
  for (const name of ['saved-drafts.json', 'last-job.json'])
    try {
      await cp(join(data, name), join(directory, name), { errorOnExist: true, force: false });
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  await writeFile(join(directory, 'before.json'), JSON.stringify({ head, config, events }, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  const recoveryRef = 'refs/sitetiller/recovery/publication-' + id;
  await project.git(['update-ref', recoveryRef, head]);
  return { directory, head, recoveryRef };
}

export async function confirmedPublicationEvidence(data: string, pending: any) {
  await atomicJson(join(data, 'publication-recovery', 'active.json'), { pending });
}
export async function restoreConfirmedPublicationEvidence(data: string, config: any) {
  let record: any;
  try {
    record = await readJson(join(data, 'publication-recovery', 'active.json'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const pending = record.pending,
    production = productionProject();
  if (!pending?.confirmedRelease) return;
  if (
    !config.pendingRelease &&
    config.draftBaseCommit === pending.confirmedRelease.commit &&
    config.publishedThrough >= pending.through
  )
    config.pendingRelease = pending;
  if (!config.pendingRelease) return;
  if (
    !production ||
    pending?.commit !== config.pendingRelease.commit ||
    pending?.number !== config.pendingRelease.number ||
    (pending?.minor ?? null) !== (config.pendingRelease.minor ?? null)
  )
    return;
  const release = (await productionReleases(production)).find(
    (r) =>
      r.commit === pending.confirmedRelease?.commit &&
      r.sourceCommit === pending.commit &&
      r.number === pending.number &&
      (r.minor ?? null) === (pending.minor ?? null),
  );
  if (release)
    config.pendingRelease = {
      ...config.pendingRelease,
      confirmedRelease: release,
      evidence: pending.evidence,
      ...(pending.rebuilt ? { rebuilt: pending.rebuilt } : {}),
      cleanupPending: true,
    };
}
