import { Problem } from './problem.ts';
export async function publicationTarget(
  project: any,
  config: any,
  commit: string,
  expectedHead?: string,
  stepId?: string,
) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit))
    throw new Problem(422, 'Neplatný krok k publikování.');
  const head = await project.head();
  if (expectedHead !== undefined && expectedHead !== head)
    throw new Problem(409, 'Návrh se mezitím změnil. Obnov seznam úprav.');
  const request = (config.requests || []).findLast(
    (r: any) => r.commit === commit && (!stepId || r.id === stepId) && ['ready', 'legacy'].includes(r.status),
  );
  if (commit !== head && !request)
    throw new Problem(409, 'Publikovat lze jen aktuální návrh nebo dostupný krok rozpracovaných úprav.');
  try {
    await project.git(['merge-base', '--is-ancestor', commit, head]);
    if (config.publishedCommit && !config.separatedHistories)
      await project.git(['merge-base', '--is-ancestor', config.publishedCommit, commit]);
  } catch {
    throw new Problem(409, 'Tento krok nelze publikovat bez návratu historie publikování. Načti jej nejprve do úprav.');
  }
  if (
    config.publishedCommit &&
    (await project.tree(commit)) === (config.publishedTree || (await project.tree(config.publishedCommit)))
  )
    throw new Problem(409, 'Tento krok je shodný s aktuální publikovanou verzí. Není co publikovat.');
  const through =
    commit === head
      ? Math.max(config.reviewedThrough || 0, ...(config.requests || []).map((r: any) => r.sequence || 0))
      : request.sequence;
  return { head, through, request };
}
export async function publishableSteps(project: any, config: any, head: string) {
  const reachable = new Set(
    (
      await project.git([
        'rev-list',
        config.separatedHistories ? head : config.publishedCommit ? config.publishedCommit + '..' + head : head,
      ])
    ).split('\n'),
  );
  const candidates = [
    ...new Set([
      head,
      ...(config.requests || []).filter((r: any) => ['ready', 'legacy'].includes(r.status)).map((r: any) => r.commit),
    ]),
  ].filter((commit: any) => reachable.has(commit));
  const tree = config.publishedTree || (config.publishedCommit ? await project.tree(config.publishedCommit) : null);
  const results = await Promise.all(
    candidates.map(async (commit: any) => (!tree || (await project.tree(commit)) !== tree ? commit : null)),
  );
  return results.filter(Boolean);
}
