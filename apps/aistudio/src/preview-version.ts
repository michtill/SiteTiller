import { cmsPreviewRoute } from './cms-preview.ts';
import type { Project } from './project.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productionProject, productionReleases } from './production-history.ts';
// Ancestry of two fixed commits never changes, so a confirmed pair is not asked again.
const ancestry = new Set<string>();
async function isAncestor(project: Project, commit: string, head: string) {
  const key = project.root + '\0' + commit + '\0' + head;
  if (ancestry.has(key)) return true;
  try {
    await project.git(['merge-base', '--is-ancestor', commit, head]);
  } catch {
    return false;
  }
  if (ancestry.size >= 1000) ancestry.delete(ancestry.values().next().value!);
  ancestry.add(key);
  return true;
}
export async function previewVersion(project: Project, url: URL, studio = false) {
  const source = cmsPreviewRoute(url.pathname.replace(/^\/preview\/?/, '').replace(/^\//, '')),
    route = source.route;
  const match = route.match(/^(?:snapshots\/)?versions\/([a-f0-9]{40})\/(.*)$/),
    head = await project.head();
  if (match) {
    const production = productionProject();
    if (production && (await productionReleases(production)).some((r) => r.commit === match[1]))
      return {
        project: production,
        commit: match[1],
        frozen: route.startsWith('snapshots/') || match[1] !== head || !source.mode,
        cmsMode: route.startsWith('snapshots/') || match[1] !== head ? undefined : source.mode,
        relative: decodeURIComponent(match[2]),
        prefix: (studio ? '/preview/' : '/') + source.sourcePrefix + 'versions/' + match[1] + '/',
      };
    try {
      const config = JSON.parse(await readFile(join(project.root, '..', 'config.json'), 'utf8'));
      if (Array.isArray(config.requests)) {
        const allowed = new Set([
          head,
          ...(config.releases || []).map((r: any) => r.commit),
          ...config.requests
            .filter((r: any) => r.status === 'ready' || r.status === 'legacy')
            .map((r: any) => r.commit),
        ]);
        if (!allowed.has(match[1])) return null;
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!(await isAncestor(project, match[1], head))) return null;
  }
  const frozen = !!match && (route.startsWith('snapshots/') || match[1] !== head);
  return {
    project,
    commit: match?.[1] || head,
    frozen,
    cmsMode: frozen ? undefined : source.mode,
    relative: decodeURIComponent(match?.[2] ?? route),
    prefix:
      (studio ? '/preview/' : '/') +
      source.sourcePrefix +
      (match ? (route.startsWith('snapshots/') ? 'snapshots/' : '') + 'versions/' + match[1] + '/' : ''),
  };
}
export function versionReferences(content: string, prefix: string) {
  return content
    .replace(/((?:src|href|action)=["'])\/(?!\/)([^"']*)/gi, (_, lead, path) => lead + prefix + path)
    .replace(
      /url\(\s*(["']?)\/(?!\/)([^)]*?)\1\s*\)/gi,
      (_, quote, path) => 'url(' + quote + prefix + path + quote + ')',
    );
}
