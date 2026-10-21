import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../../../packages/settings/index.mjs';
// The controller derives the only data Publisher may trust from its config; Publisher never reads config.json.
export function publishApproval(config: any) {
  return config.approvedCommit
    ? {
        commit: config.approvedCommit,
        head: config.technicalApproval?.head || config.approvedCommit,
        checks: config.technicalApproval?.checks || 'strict',
        intent: config.pendingRelease || null,
      }
    : null;
}
export function archiveApproval(config: any) {
  const request = (config.requests || []).findLast(
    (r: any) => r.status === 'ready' && r.webImport?.source === 'hosting-http' && r.webImport.hostingCommit,
  );
  return request ? { commit: request.commit, hostingCommit: request.webImport.hostingCommit } : null;
}
export async function writeApprovals(data: string, config: any) {
  await atomicJson(join(data, 'publish-approval.json'), publishApproval(config));
  await atomicJson(join(data, 'archive-approval.json'), archiveApproval(config));
}
export async function readApproval(data: string, name: 'publish' | 'archive') {
  try {
    return JSON.parse(await readFile(join(data, name + '-approval.json'), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
