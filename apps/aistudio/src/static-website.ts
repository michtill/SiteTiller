// External presentation (documentation 7.7): the static export of the current release goes to the website's own Git
// (SITETILLER_WEBSITE_GIT, branch SITETILLER_WEBSITE_BRANCH), which a web hosting deploys. The version history stays in
// the instance. Others may write to the website Git too: a branch that is not where SiteTiller left it stops the
// write until the owner confirms it ("Publish anyway"); the new commit then goes on top, nothing is deleted.
// One writer (the Publisher), one call at a time; the outcome is kept in .production/website.json for the studios.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readRelease, staticExport } from './static-export.ts';
import { atomicJson } from '../../../packages/settings/index.mjs';
const exec = promisify(execFile);
export const websiteGit = () => process.env.SITETILLER_WEBSITE_GIT || '';
const branch = () => process.env.SITETILLER_WEBSITE_BRANCH || 'main';
const production = () => process.env.SITETILLER_PRODUCTION_DIRECTORY!;
const statePath = () => join(production(), 'website.json');
export async function websiteState() {
  try {
    return JSON.parse(await readFile(statePath(), 'utf8'));
  } catch {
    return null;
  }
}
// Before a publication: has someone else written to the website Git since SiteTiller's last write?
export async function websiteForeign() {
  if (!websiteGit()) return null;
  const state = (await websiteState()) || {},
    head =
      (await exec('git', ['ls-remote', websiteGit(), 'refs/heads/' + branch()], { windowsHide: true, timeout: 60000 }))
        .stdout.split(/\s/)[0] || '';
  return head && head !== (state.pushed || '') ? { head } : null;
}
let queue: Promise<unknown> = Promise.resolve();
export function publishStaticWebsite(options: { force?: boolean } = {}) {
  const run = queue.then(
    () => writeWebsite(options),
    () => writeWebsite(options),
  );
  queue = run.catch(() => {});
  return run;
}
async function writeWebsite({ force = false }: { force?: boolean }) {
  if (!websiteGit()) return { skipped: true };
  const previous = (await websiteState()) || {};
  try {
    const result = await write(previous, force);
    await atomicJson(statePath(), {
      pushed: result.commit,
      ...(result.foreign ? { foreign: result.foreign } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
      at: new Date().toISOString(),
    });
    return result;
  } catch (e: any) {
    await atomicJson(statePath(), { ...previous, error: 'write', at: new Date().toISOString() });
    throw e;
  }
}
async function write(previous: any, force: boolean) {
  const target = websiteGit(),
    pointer = JSON.parse(await readFile(join(production(), 'current.json'), 'utf8')),
    files = await staticExport(await readRelease(pointer.directory), {
      siteUrl: process.env.SITETILLER_SITE_URL || 'http://localhost/',
      mailFrom: process.env.SITETILLER_MAIL_FROM,
      mailTo: process.env.SITETILLER_MAIL_TO,
    });
  // A local copy of the website Git to build commits in.
  const cache = join(production(), 'website.git'),
    git = async (args: string[], env: NodeJS.ProcessEnv = process.env) =>
      (await exec('git', ['--git-dir=' + cache, ...args], { env, windowsHide: true, timeout: 120000, maxBuffer: 10000000 }))
        .stdout.trim();
  if (!existsSync(join(cache, 'HEAD'))) {
    await mkdir(dirname(cache), { recursive: true });
    await exec('git', ['init', '--bare', '-b', 'main', cache], { windowsHide: true });
  }
  const remoteHead =
    (await exec('git', ['ls-remote', target, 'refs/heads/' + branch()], { windowsHide: true, timeout: 120000 })).stdout.split(
      /\s/,
    )[0] || '';
  if (remoteHead) await git(['fetch', '--no-tags', target, '+refs/heads/' + branch() + ':refs/remotes/website']);
  // Someone else wrote since SiteTiller's last write: stop unless the owner confirmed.
  if (remoteHead && remoteHead !== (previous.pushed || '') && !force)
    return { commit: previous.pushed || null, changed: false, foreign: { head: remoteHead } };
  const work = await mkdtemp(join(tmpdir(), 'sitetiller-www-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(work, 'tree', name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'index') },
      inTree = (args: string[]) => git(['--work-tree=' + join(work, 'tree'), ...args], env);
    await inTree(['-c', 'core.autocrlf=false', 'add', '-A', '--', '.']);
    const tree = await inTree(['write-tree']);
    if (remoteHead && (await git(['rev-parse', remoteHead + '^{tree}'])) === tree)
      return { commit: remoteHead, changed: false };
    const commit = await git([
      '-c',
      'user.name=SiteTiller Publisher',
      '-c',
      'user.email=publisher@sitetiller.local',
      'commit-tree',
      tree,
      ...(remoteHead ? ['-p', remoteHead] : []),
      '-m',
      'Publish website\n\nSiteTiller-Release: ' + pointer.id,
    ]);
    // No force: the push fails if the branch moved again in the meantime.
    await exec('git', ['--git-dir=' + cache, 'push', target, commit + ':refs/heads/' + branch()], {
      windowsHide: true,
      timeout: 120000,
    });
    const warning = process.env.SITETILLER_WWW_URL ? await verify(files, process.env.SITETILLER_WWW_URL) : null;
    return { commit, changed: true, ...(warning ? { warning } : {}) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
// The hosting deploys within seconds; the public files must match the export (PHP scripts run, so they are skipped).
async function verify(files: Record<string, Buffer>, siteUrl: string) {
  const names = Object.keys(files).filter((n) => /\.(html?|css|js)$/.test(n));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const checks = await Promise.all(
        names.map(async (name) => {
          const url = new URL(name === 'index.html' ? './' : name, siteUrl);
          url.searchParams.set('sitetiller', String(Date.now()));
          const response = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
          return response.ok && Buffer.from(await response.arrayBuffer()).equals(files[name]);
        }),
      );
      if (checks.every(Boolean)) return null;
    } catch {
      /* The hosting may still be deploying. */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 'Web je zapsaný do Gitu, ale veřejná adresa zatím neukazuje novou verzi.';
}
