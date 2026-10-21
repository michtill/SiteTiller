import http from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson, readJson } from '../../packages/settings/index.mjs';
import { publicPreviewEnabled } from './public-preview.ts';
// Shared previews (documentation 4.10): links /s/<code>/ on the public preview address to one frozen state. The list
// with the whole codes is settings/shares.json (600), so a link can be copied again; only the instance reads it.
export type Share = {
  id: string;
  code: string;
  kind: 'step' | 'draft' | 'release';
  label: string;
  // What was shared: the step (by its id, its commit may change when the draft is rebuilt), saved draft or version.
  stepId?: string | null;
  commit?: string;
  draftId?: string;
  releaseId?: string;
  createdBy: string;
  createdAt: string;
  expires: string | null;
};
export const validities: Record<string, number | null> = { '1d': 1, '7d': 7, '30d': 30, none: null };
const file = (data: string) => join(data, 'settings/shares.json');
let writes: Promise<unknown> = Promise.resolve();
async function read(data: string): Promise<Share[]> {
  try {
    const value = await readJson(file(data));
    return Array.isArray(value) ? value : [];
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return [];
  }
}
function change<T>(data: string, fn: (shares: Share[]) => T | Promise<T>, list?: (shares: Share[]) => Share[]) {
  const run = writes.then(async () => {
    let shares = await read(data);
    const result = await fn(shares);
    if (list) shares = list(shares);
    await atomicJson(file(data), shares, { mode: 0o600 });
    return result;
  });
  writes = run.catch(() => {});
  return run;
}
const live = (share: Share) => !share.expires || Date.parse(share.expires) > Date.now();
export type ShareContext = { data: string; secret: string; aiPort: number; publicOrigin: string };
async function ai(ctx: ShareContext, path: string, value: unknown) {
  const response = await fetch('http://127.0.0.1:' + ctx.aiPort + '/api/' + path, {
    method: 'POST',
    headers: {
      'x-sitetiller-gateway': ctx.secret,
      origin: 'http://127.0.0.1:' + ctx.aiPort,
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(120000),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(result.error || 'AI Studio neodpovídá.'), { status: response.status });
  return result;
}
export const shareUrl = (ctx: ShareContext, share: Share) => ctx.publicOrigin + '/s/' + share.code + '/';
// The links to one shared state (the Share dialog, documentation 4.10). Expired links and links whose step or saved
// draft no longer exists are dropped, and their pinned states released.
// All valid links (Settings → Shared previews, documentation 2.4).
export async function allShares(ctx: ShareContext) {
  const all = await read(ctx.data),
    { alive } = await ai(ctx, 'share-snapshot/alive', { ids: all.filter(live).map((s) => s.id) }),
    kept = all.filter((s) => live(s) && alive.includes(s.id));
  if (kept.length !== all.length) {
    await change(
      ctx.data,
      () => {},
      (shares) => shares.filter((s) => kept.some((k) => k.id === s.id)),
    );
    for (const share of all.filter((s) => !live(s)))
      await ai(ctx, 'share-snapshot/remove', { id: share.id }).catch(() => {});
  }
  return kept;
}
export async function sharesFor(
  ctx: ShareContext,
  source: { kind: string; stepId?: string; commit?: string; draftId?: string; releaseId?: string },
) {
  return (await allShares(ctx)).filter(
    (s) =>
      s.kind === source.kind &&
      (source.kind === 'step'
        ? source.stepId
          ? s.stepId === source.stepId
          : !s.stepId && s.commit === source.commit
        : source.kind === 'draft'
          ? s.draftId === source.draftId
          : s.releaseId === source.releaseId),
  );
}
export async function createShare(
  ctx: ShareContext,
  input: {
    kind: string;
    stepId?: string;
    commit?: string;
    draftId?: string;
    releaseId?: string;
    validity?: string;
    createdBy: string;
  },
) {
  if (!ctx.publicOrigin || !(await publicPreviewEnabled(ctx.data)))
    throw Object.assign(Error('Sdílení vyžaduje zapnutý veřejný náhled (Nastavení → Rozhraní).'), { status: 409 });
  const validity = input.validity ?? '30d';
  if (!Object.hasOwn(validities, validity)) throw Object.assign(Error('Neplatná platnost odkazu.'), { status: 422 });
  const id = randomBytes(16).toString('hex'),
    frozen = await ai(ctx, 'share-snapshot', {
      id,
      kind: input.kind,
      stepId: input.stepId,
      commit: input.commit,
      draftId: input.draftId,
      releaseId: input.releaseId,
    }),
    days = validities[validity],
    share: Share = {
      id,
      code: randomBytes(32).toString('hex'),
      kind: input.kind as Share['kind'],
      label: frozen.label,
      ...(input.kind === 'step'
        ? { stepId: frozen.stepId, commit: input.commit || '' }
        : input.kind === 'draft'
          ? { draftId: input.draftId }
          : { releaseId: input.releaseId }),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      expires: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
    };
  await change(ctx.data, (shares) => {
    shares.push(share);
  });
  return { url: shareUrl(ctx, share), expires: share.expires, label: share.label };
}
// One link, or all of them (id null).
export async function revokeShare(ctx: ShareContext, id: string | null) {
  const removed = await change(
    ctx.data,
    (shares) => shares.filter((s) => id === null || s.id === id),
    (shares) => shares.filter((s) => id !== null && s.id !== id),
  );
  for (const share of removed) await ai(ctx, 'share-snapshot/remove', { id: share.id }).catch(() => {});
  return removed.length;
}
// /s/<code>/... on the public preview address: only GET and HEAD (and the form check of the preview, which sends
// nothing). The preview's own paths of the share are replaced by the link's.
export async function serveShare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: { data: string; previewPort: number; origin: string },
) {
  const match = url.pathname.match(/^\/s\/([a-f0-9]{64})(\/.*)?$/);
  if (!match) return false;
  const share = (await read(options.data)).find((s) => s.code === match[1] && live(s)),
    form =
      req.method === 'POST' && /^\/__sitetiller\/forms\//.test(match[2] || '') && req.headers.origin === options.origin;
  if (!share || !(['GET', 'HEAD'].includes(req.method || '') || form) || /\\|%2e|%2f|%5c/i.test(url.pathname)) {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (!match[2]) {
    res.writeHead(302, { Location: '/s/' + share.code + '/' });
    res.end();
    return true;
  }
  const internal = '/shares/' + share.id + '/',
    external = '/s/' + share.code + '/',
    headers: http.OutgoingHttpHeaders = { host: '127.0.0.1:' + options.previewPort };
  for (const name of ['accept', 'accept-language', 'content-type'])
    if (req.headers[name]) headers[name] = req.headers[name];
  const proxy = http.request(
    {
      hostname: '127.0.0.1',
      port: options.previewPort,
      path: internal + match[2].slice(1) + url.search,
      method: req.method,
      headers,
    },
    (response) => {
      const out = { ...response.headers };
      delete out['set-cookie'];
      delete out['access-control-allow-origin'];
      out['cache-control'] = 'no-store';
      if (typeof out.location === 'string') out.location = out.location.split(internal).join(external);
      if (/^(text\/|application\/(json|javascript))/.test(String(out['content-type'] || ''))) {
        const chunks: Buffer[] = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').split(internal).join(external);
          delete out['content-length'];
          res.writeHead(response.statusCode || 502, out);
          res.end(req.method === 'HEAD' ? undefined : body);
        });
      } else {
        res.writeHead(response.statusCode || 502, out);
        response.pipe(res);
      }
    },
  );
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
  return true;
}
