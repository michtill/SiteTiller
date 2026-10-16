import { posix } from 'node:path';
// Static local dependencies only. Keep both graphs so removed consumers remain visible.
export function sharedModuleContext(files: Record<string, string>, baseline: Record<string, string> = files) {
  const consumers = new Map<string, Set<string>>();
  for (const snapshot of [baseline, files]) {
    const edges = new Map<string, string[]>();
    for (const [path, text] of Object.entries(snapshot)) {
      if (!/\.(?:html|js|txt)$/.test(path)) continue;
      const refs = [
        ...text.matchAll(
          /(?:\b(?:import|export)\s+[\s\S]*?\bfrom\s*|\bimport\s*)["']([^"']+)["']|<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
        ),
      ].map((m) => m[1] || m[2]);
      edges.set(
        path,
        refs
          .filter((ref) => !/^(?:[a-z]+:|\/\/)/i.test(ref))
          .map((ref) => {
            const clean = ref.split(/[?#]/)[0];
            return clean.startsWith('/') ? 'site' + clean : posix.normalize(posix.join(posix.dirname(path), clean));
          })
          .filter((p) => Object.hasOwn(snapshot, p)),
      );
    }
    for (const page of Object.keys(snapshot).filter((p) => p.endsWith('.html'))) {
      const seen = new Set<string>();
      const walk = (p: string) => {
        if (seen.has(p)) return;
        seen.add(p);
        for (const dependency of edges.get(p) || []) walk(dependency);
      };
      walk(page);
      for (const p of seen)
        if (p.endsWith('.js')) {
          if (!consumers.has(p)) consumers.set(p, new Set());
          consumers.get(p)!.add(page);
        }
    }
  }
  const exportsOf = (text: string) =>
    [...text.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
  return [...consumers]
    .filter(([, pages]) => pages.size > 1)
    .map(([path, pages]) => ({
      path,
      pages: [...pages].sort(),
      changed: baseline[path] !== files[path],
      beforeBytes: Buffer.byteLength(baseline[path] || ''),
      afterBytes: Buffer.byteLength(files[path] || ''),
      previousExports: exportsOf(baseline[path] || ''),
      currentExports: exportsOf(files[path] || ''),
    }));
}
