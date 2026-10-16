import { atomicJson } from '../../../packages/settings/index.mjs';
import { pruneNewest } from '../../../packages/content/files.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, chmod, cp, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from './project.ts';
import { raster } from './images.ts';
import { safeSitePath } from './core.ts';
export async function rebaseWorkspace(
  work: Project,
  production: Project,
  published: string,
  selected: string,
  retain?: string[],
) {
  const head = await work.head(),
    newer = (await work.git(['rev-list', '--first-parent', '--reverse', selected + '..' + head]))
      .split('\n')
      .filter((commit) => !!commit && (!retain || retain.includes(commit))),
    parent = join(work.root, '..'),
    temporary = await mkdtemp(join(parent, 'workspace-next-'));
  const fresh = new Project(temporary),
    mapping: Record<string, string> = { [selected]: published };
  try {
    // The independent publisher reads this directory through the shared hosting group.
    await chmod(temporary, 0o2750);
    await fresh.git(['init', '-b', 'main']);
    await fresh.git(['config', 'core.autocrlf', 'false']);
    await fresh.git(['config', 'user.name', 'SiteTiller']);
    await fresh.git(['config', 'user.email', 'sitetiller@localhost']);
    await fresh.git(['fetch', '--depth=1', production.root, published]);
    await fresh.git(['checkout', '-B', 'main', 'FETCH_HEAD']);
    let tip = published;
    for (const old of newer) {
      await fresh.git(['fetch', '--no-tags', work.root, old]);
      const tree = await work.git(['rev-parse', old + '^{tree}']);
      tip = await fresh.git(['commit-tree', tree, '-p', tip, '-m', await work.git(['show', '-s', '--format=%s', old])]);
      mapping[old] = tip;
      if ((await fresh.git(['rev-parse', tip + '^{tree}'])) !== tree) throw Error('Novější pracovní snímek se změnil.');
    }
    await fresh.git(['checkout', '-B', 'main', tip]);
    if ((await work.head()) !== head) throw Error('Návrh se mezitím změnil.');
    await assertWorkspaceClean(work);
    const id = randomUUID(),
      recoveryRef = 'refs/sitetiller/recovery/' + id,
      recoveryRepository = join(parent, 'workspace-history', id, 'repository.git');
    await mkdir(join(recoveryRepository, '..'), { recursive: true, mode: 0o700 });
    await cp(join(work.root, '.git'), recoveryRepository, { recursive: true });
    await work.git(['update-ref', recoveryRef, head]);
    const shallowPath = join(work.root, '.git', 'shallow'),
      previousShallow = await readFile(shallowPath, 'utf8').catch((e: any) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }),
      freshShallow = await readFile(join(temporary, '.git', 'shallow'), 'utf8').catch((e: any) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
    const replaceShallow = async (text: string | null) => {
      if (text === null) {
        await rm(shallowPath, { force: true });
        return;
      }
      const temp = shallowPath + '.' + id + '.tmp';
      await writeFile(temp, text);
      await rename(temp, shallowPath);
    };
    const next = await fresh.head();
    await atomicJson(join(recoveryRepository, '..', 'plan.json'), {
      oldHead: head,
      head: next,
      mapping,
      published,
      selected,
      recoveryRef,
      recoveryRepository,
    });
    await work.git(['fetch', '--no-tags', '--update-shallow', fresh.root, next]);
    try {
      await work.git(['read-tree', '--reset', '-u', next]);
      const boundaries = Array.from(
        new Set((String(previousShallow || '') + '\n' + freshShallow).split('\n').filter(Boolean)),
      );
      if (boundaries.some((commit) => !/^[a-f0-9]{40}$/.test(commit))) throw Error('Neplatná hranice historie.');
      if (boundaries.length) await replaceShallow(boundaries.join('\n') + '\n');
      await work.git(['update-ref', 'HEAD', next, head]);
    } catch (error: any) {
      try {
        await replaceShallow(previousShallow);
        await work.git(['read-tree', '--reset', '-u', await work.head()]);
      } catch (rollback: any) {
        throw Object.assign(
          Error(
            'Uzavření návrhu selhalo; historie je zachována v ' +
              recoveryRef +
              '. Obnovení souborů vyžaduje dokončení.',
          ),
          { cause: error, rollbackError: rollback, code: error.code || 'WORKSPACE_RECOVERY_REQUIRED', recoveryRef },
        );
      }
      throw error;
    }
    // Retention: this copy is the newest; the three most recent copies remain (an unfinished publication's is among them).
    await pruneNewest(join(parent, 'workspace-history'), { keep: 3 }).catch(() => {});
    return { head: next, mapping, recoveryRef, recoveryRepository };
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

export async function assertWorkspaceClean(work: Project) {
  if (
    (await work.git(['status', '--porcelain', '--untracked-files=no'])) ||
    (await work.git(['status', '--porcelain', '--', 'site']))
  )
    throw Error('Návrh obsahuje neuložené změny webu.');
}
export async function prepareWorkspacePublication(work: Project, selected: string) {
  await assertWorkspaceClean(work);
  const head = await work.head();
  await work.git(['merge-base', '--is-ancestor', selected, head]);
  const commits = [
      selected,
      ...(await work.git(['rev-list', '--first-parent', '--reverse', selected + '..' + head]))
        .split('\n')
        .filter(Boolean),
    ],
    snapshots = [];
  for (const commit of commits) {
    const tree = await work.git(['rev-parse', commit + '^{tree}']);
    await work.git(['cat-file', '-e', tree]);
    snapshots.push({ commit, tree });
  }
  return { head, selected, snapshots };
}
