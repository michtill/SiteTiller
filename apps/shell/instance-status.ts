import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
// The instance status for a waker in front of a stopped instance (documentation 2.6): whether the instance is
// working, and since when nobody used it. Only with the token from settings/status.token; otherwise 404, so the
// address is not visible from outside. A status call is not activity.
export const statusPath = '/__sitetiller/status';
let lastActivity = new Date().toISOString();
export function noteActivity() {
  lastActivity = new Date().toISOString();
}
export async function statusToken(settingsDirectory: string) {
  const file = join(settingsDirectory, 'status.token');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const token = randomBytes(32).toString('hex');
    await writeFile(file, token, { mode: 0o600, flag: 'wx' }).catch(() => {});
    return (await readFile(file, 'utf8')).trim();
  }
}
export async function serveStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  aiBusy: () => Promise<boolean>,
) {
  const given = String(req.headers.authorization || '').replace(/^Bearer /, ''),
    valid =
      req.method === 'GET' &&
      given.length === token.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (!valid) {
    res.writeHead(404);
    return res.end();
  }
  // An AI Studio that does not answer counts as working: the waker must not stop the instance then.
  const busy = await aiBusy().catch(() => true);
  if (busy) noteActivity();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ busy, lastActivity }));
}
