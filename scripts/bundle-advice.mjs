// Bundles the published recommendations from SiteTiller-advice into the application (documentation 4.6): before every
// release the release session runs
//   node scripts/bundle-advice.mjs          downloads the recommendation sets, validates them and writes the copy
//   node scripts/bundle-advice.mjs --check  only says whether the bundled copy equals the published one
// A copy is never edited by hand. An invalid file, or one with no higher revision than the bundled copy, writes nothing.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { recommendedSetsUrl, recommendedLimit, parseRecommendationSets } from '../packages/models/index.mjs';
const files = [
  { url: recommendedSetsUrl, path: 'packages/models/recommended-sets.json', parse: parseRecommendationSets },
];
export async function bundleAdvice({ check = false, fetcher = fetch, root = new URL('..', import.meta.url) } = {}) {
  const results = [];
  for (const { url, path, parse } of files) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(url + ': HTTP ' + response.status);
    const text = await response.text();
    if (text.length > recommendedLimit) throw Error(url + ': larger than ' + recommendedLimit + ' bytes');
    const published = parse(text);
    if (!published) throw Error(url + ': not a valid recommendation file');
    const target = new URL(path, root),
      bundledText = await readFile(target, 'utf8'),
      bundled = JSON.parse(bundledText);
    const same = bundledText === text;
    if (!same && !(published.revision > bundled.revision))
      throw Error(
        path + ': the published file (revision ' + published.revision + ') is not newer than the bundled one (revision ' + bundled.revision + ')',
      );
    if (!same && !check) await writeFile(target, text);
    results.push({ path, revision: published.revision, date: published.date, same });
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  try {
    const results = await bundleAdvice({ check });
    for (const r of results)
      console.log(r.path + ': ' + (r.same ? 'equals the published ' : check ? 'differs from the published ' : 'bundled ') + 'revision ' + r.revision + ' (' + r.date + ')');
    if (check && results.some((r) => !r.same)) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
