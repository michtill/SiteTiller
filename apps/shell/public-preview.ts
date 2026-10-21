// The public draft preview: on the instance's public preview address, without signing in, the current draft (its
// latest step) with the working content, read-only. Nothing else of the studios exists there: older steps, saved
// drafts, published versions and other content sources are refused. It answers only while the common settings
// turn it on; otherwise 404.
import http from 'node:http';
import { join } from 'node:path';
import { readJson } from '../../packages/settings/index.mjs';
import { serveShare } from './shares.ts';
const source = '/sources/unpublished';
// The public path of a draft page → the preview service's path; null for everything that is not the current draft.
export function publicPreviewPath(pathname: string) {
  if (/\\|\/\.\.(\/|$)|%2e|%2f|%5c/i.test(pathname)) return null;
  // The preview writes its own references with the content source prefix; both forms lead to the same page.
  const rest =
    pathname === source || pathname.startsWith(source + '/') ? pathname.slice(source.length) || '/' : pathname;
  if (/^\/(versions|snapshots|drafts|shares|sources|health)(\/|$)/.test(rest)) return null;
  return source + rest;
}
export async function publicPreviewEnabled(data: string) {
  try {
    return (await readJson(join(data, 'settings/shared.json'))).publicPreview === true;
  } catch {
    return false;
  }
}
export async function servePublicPreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { origin: string; data: string; previewPort: number },
) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url || '/', options.origin);
  // Search engines stay out of the whole public preview address, shared links included (documentation 4.10).
  if (url.pathname === '/robots.txt' && ['GET', 'HEAD'].includes(req.method || '')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
    if ((await publicPreviewEnabled(options.data)) && (await serveShare(req, res, url, options))) return;
    res.writeHead(404);
    return res.end();
  }
  const form = req.method === 'POST' && url.pathname.startsWith('/__sitetiller/forms/'),
    path = form ? source + url.pathname : publicPreviewPath(url.pathname);
  if (
    !path ||
    !(await publicPreviewEnabled(options.data)) ||
    !(['GET', 'HEAD'].includes(req.method || '') || (form && req.headers.origin === options.origin))
  ) {
    res.writeHead(404);
    return res.end();
  }
  // Only what the page needs; cookies and studio headers never reach the preview.
  const headers: http.OutgoingHttpHeaders = { host: '127.0.0.1:' + options.previewPort };
  for (const name of ['accept', 'accept-language', 'content-type'])
    if (req.headers[name]) headers[name] = req.headers[name];
  const proxy = http.request(
    { hostname: '127.0.0.1', port: options.previewPort, path: path + url.search, method: req.method, headers },
    (response) => {
      const out = { ...response.headers };
      delete out['set-cookie'];
      delete out['access-control-allow-origin'];
      res.writeHead(response.statusCode || 502, out);
      response.pipe(res);
    },
  );
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
}
