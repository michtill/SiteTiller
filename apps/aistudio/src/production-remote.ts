// The production Git can be a remote repository reached over SSH (an application of a hosting panel cannot mount the
// hosting's Git directory). SITETILLER_PRODUCTION_REMOTE is then that address and SITETILLER_PRODUCTION_GIT a local
// mirror in the instance: every reader (AI Studio, release list, workspace rebuild) reads the mirror, the Publisher
// refreshes it from the remote and pushes publications and release tags there. The hosting's deploy hooks run on
// the server. Without SITETILLER_PRODUCTION_REMOTE the production Git is the local repository itself.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const exec = promisify(execFile);
export const productionRemote = () => process.env.SITETILLER_PRODUCTION_REMOTE || '';
// Where publications are pushed: the remote address, or the local repository.
export const productionTarget = () => productionRemote() || process.env.SITETILLER_PRODUCTION_GIT || '';
const git = (args: string[]) =>
  exec('git', args, { windowsHide: true, timeout: 120000, maxBuffer: 1000000, env: process.env });
// Brings the local mirror up to date: main follows the remote, release tags are added (never replaced).
export async function syncProductionMirror() {
  const remote = productionRemote(),
    mirror = process.env.SITETILLER_PRODUCTION_GIT;
  if (!remote || !mirror) return;
  if (!existsSync(join(mirror, 'HEAD'))) {
    await mkdir(dirname(mirror), { recursive: true });
    await git(['init', '--bare', '-b', 'main', mirror]);
  }
  await git([
    '-C',
    mirror,
    'fetch',
    '--no-tags',
    remote,
    '+refs/heads/main:refs/heads/main',
    'refs/tags/sitetiller/published/*:refs/tags/sitetiller/published/*',
  ]);
}
// Publishes refs of the mirror to the remote (a production commit or a release tag); nothing to do locally.
export async function pushProductionRefs(refspecs: string[]) {
  const remote = productionRemote();
  if (!remote) return;
  await git(['-C', process.env.SITETILLER_PRODUCTION_GIT!, 'push', remote, ...refspecs]);
}
