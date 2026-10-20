import type { Project } from './project.ts';
// Git compares binary blobs too; CMS JSON formatting does not create a new design.
export async function stepChanges(project: Project, before: string, after: string, stagingSources: string[] = []) {
  const actualFiles = stagingSources.length ? await project.committedFiles(after) : {},
    publicText = Object.entries(actualFiles)
      .filter(([p]) => !p.startsWith('site/cms/') && p !== 'site/architecture.txt')
      .map(([, value]) => value)
      .join('\n');
  const contentStaging = new Set(
    stagingSources.filter(
      (path) => !publicText.includes(path.slice(5)) && !publicText.includes(path.split('/').at(-1)!),
    ),
  );
  const paths = (await project.git(['diff', '--name-only', before, after, '--', 'site'])).split('\n').filter(Boolean),
    content: string[] = [],
    presentation: string[] = [],
    metadata: string[] = [];
  for (const path of paths) {
    if (path === 'site/architecture.txt') {
      metadata.push(path);
      continue;
    }
    if (path.startsWith('site/cms/') || contentStaging.has(path)) {
      if (path.endsWith('.json')) {
        try {
          const a = JSON.parse((await project.binary(before, path)).toString()),
            b = JSON.parse((await project.binary(after, path)).toString()),
            normalize = (v: any): any =>
              Array.isArray(v)
                ? v.map(normalize)
                : v && typeof v === 'object'
                  ? Object.fromEntries(
                      Object.keys(v)
                        .sort()
                        .map((k) => [k, normalize(v[k])]),
                    )
                  : v;
          if (
            path === 'site/cms/structure.json'
              ? JSON.stringify(a) === JSON.stringify(b)
              : JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
          )
            continue;
        } catch {}
      }
      content.push(path);
    } else presentation.push(path);
  }
  // Every step that changes something has its own preview: a content change too shows the page with the new content
  // (documentation 4.2). presentationChanged therefore means "the step has a preview".
  return {
    presentationChanged: !!(presentation.length || content.length),
    contentChanged: !!content.length,
    changeKind: presentation.length
      ? content.length
        ? 'combined'
        : 'presentation'
      : content.length
        ? 'content'
        : 'unchanged',
    changedPaths: { presentation, content, metadata },
  };
}
// A step that loads a version into a draft without steps is the draft's starting version: there is no previous
// step to compare with, so it is a version with its own preview. Later loads are classified by their differences.
export async function loadedStepChanges(config: any, project: Project, before: string, after: string) {
  const first = !(config.requests || []).some((r: any) => ['ready', 'legacy'].includes(r.status) && r.commit);
  return first ? { presentationChanged: true, changeKind: 'version' } : stepChanges(project, before, after);
}
// The first step of a draft is always a version with its own preview, however it came about (a load, an AI step,
// a step that stays first after a publication or a save): there is no previous step to compare it with.
export function startingVersion(config: any) {
  const first = (config.requests || []).find((r: any) => ['ready', 'legacy'].includes(r.status) && r.commit);
  if (!first || first.presentationChanged !== false) return;
  Object.assign(first, { presentationChanged: true, changeKind: 'version' });
  // With no later presentation step, the preview shows this step.
  const shown = presentationState(config, first.commit);
  if (shown.presentationStepId === first.id)
    Object.assign(config, { presentationHead: first.commit, presentationStepId: first.id });
}
export function presentationState(config: any, head: string) {
  const step = (config.requests || []).findLast(
    (r: any) => ['ready', 'legacy'].includes(r.status) && r.commit && r.presentationChanged !== false,
  );
  return {
    presentationHead:
      step?.commit || config.presentationHead || config.draftBaseCommit || config.publishedCommit || head,
    presentationStepId: step?.id || config.presentationStepId || null,
  };
}
