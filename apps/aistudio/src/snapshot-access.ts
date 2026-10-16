import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Project } from './project.ts';
export async function snapshotAccessSecret(project: Project) {
  return process.env.SITETILLER_GATEWAY_TOKEN
    ? Buffer.from(process.env.SITETILLER_GATEWAY_TOKEN)
    : await readFile(join(project.root, '..', 'master.key'));
}
const signature = (secret: Buffer, id: string, commit: string, expires: string) =>
  createHmac('sha256', secret)
    .update('sitetiller-saved-preview-v1\0' + id + '\0' + commit + '\0' + expires)
    .digest('hex');
export function issueSnapshotAccess(secret: Buffer, id: string, commit: string) {
  const expires = String(Date.now() + 15 * 60 * 1000);
  return { token: expires + '-' + signature(secret, id, commit, expires), expires: Number(expires) };
}
export function validSnapshotAccess(secret: Buffer, id: string, commit: string, token: string) {
  const match = token?.match(/^([0-9]{13})-([a-f0-9]{64})$/);
  if (!match || Number(match[1]) <= Date.now() || Number(match[1]) - Date.now() > 15 * 60 * 1000) return false;
  return timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(signature(secret, id, commit, match[1]), 'hex'));
}
