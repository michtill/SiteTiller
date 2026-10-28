import { hostingPolicyPath } from './hosting-policy-probe.ts';
import { runtimeRootPolicy, serveHostingPolicy } from './hosting-policy-endpoint.ts';
import { renderCmsPage, renderingPages } from './cms-render.ts';
// Production runtime for an exported SiteTiller site; exposes neither studio nor credentials.
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { serveForm, formDefinitions } from './contact-forms.ts';
import { liveCms } from './cms-live.ts';
import { productionPolicy, privateSiteFiles } from './site-policy.ts';
function safeTemplate(path: string) {
  if (!/^site\/templates\/[\w/-]+\.txt$/.test(path) || path.split('/').includes('..'))
    throw Error('Invalid template path');
}
export function websiteServer(directory: string, origin: string) {
  const configured = new URL(origin);
  if (
    !['http:', 'https:'].includes(configured.protocol) ||
    configured.pathname !== '/' ||
    configured.search ||
    configured.hash
  )
    throw Error('Set an HTTP(S) site origin.');
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
  };
  const serve = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', productionPolicy);
      const url = new URL(req.url || '/', origin),
        relative = decodeURIComponent(url.pathname).slice(1);
      if (
        privateSiteFiles.has(relative) ||
        relative.split('/').some((p) => p.startsWith('.') || p.includes('\\') || p.includes(':'))
      ) {
        res.writeHead(404);
        return res.end();
      }
      const root = await realpath(directory);
      const contained = async (path: string) => {
        const actual = await realpath(path);
        if (!actual.startsWith(root + sep)) throw Error();
        return actual;
      };
      if (relative.startsWith('__sitetiller/forms/')) {
        let source;
        try {
          source = await readFile(await contained(resolve(root, 'forms.json')), 'utf8');
        } catch {}
        const files: Record<string, string> = source ? { 'site/forms.json': source } : {};
        if (source && !process.env.SITETILLER_CMS_ROOT) {
          try {
            const defs = formDefinitions(files);
            for (const path of new Set([
              'cms/structure.json',
              ...Object.values(defs)
                .filter((f) => f.recipientFromCms)
                .map((f) => 'cms/data/' + f.recipientFromCms!.collection + '.json'),
            ]))
              files['site/' + path] = await readFile(await contained(resolve(root, path)), 'utf8');
          } catch {}
        }
        if (
          await serveForm(req, res, relative, files, {
            preview: process.env.SITETILLER_FORM_PREVIEW === '1',
            origin: configured.origin,
          })
        )
          return;
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405);
        return res.end();
      }
      const cms = await liveCms(relative);
      if (cms) {
        res.writeHead(cms.status, { 'Content-Type': cms.mime, 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : cms.body);
      }
      let path = resolve(root, relative || 'index.html');
      if (url.pathname.endsWith('/')) path = resolve(root, relative, 'index.html');
      const extension = extname(path).toLowerCase();
      if (!mime[extension]) throw Error();
      let body: any = await readFile(await contained(path));
      if (extension === '.html') {
        let manifest;
        try {
          manifest = await readFile(await contained(resolve(root, 'rendering.json')), 'utf8');
        } catch {}
        if (manifest) {
          const page =
            'site/' + (relative || 'index.html') + (relative && url.pathname.endsWith('/') ? 'index.html' : '');
          const files: Record<string, string> = { 'site/rendering.json': manifest, [page]: body.toString('utf8') };
          const config = JSON.parse(manifest);
          for (const [entry, template] of Object.entries(config.pages || {}) as [string, string][]) {
            files[entry] = files[entry] || 'entry';
            if (typeof template !== 'string') throw Error();
            safeTemplate(template);
            files[template] = await readFile(await contained(resolve(root, template.slice(5))), 'utf8');
          }
          if (!process.env.SITETILLER_CMS_ROOT) {
            files['site/cms/structure.json'] = await readFile(
              await contained(resolve(root, 'cms/structure.json')),
              'utf8',
            );
            const schema = JSON.parse(files['site/cms/structure.json']);
            for (const n of Object.keys(schema.lists || {})) {
              if (!/^[a-zA-Z][\w-]{0,63}$/.test(n)) throw Error();
              files['site/cms/data/' + n + '.json'] = await readFile(
                await contained(resolve(root, 'cms/data/' + n + '.json')),
                'utf8',
              );
            }
          }
          body = (await renderCmsPage(page, files, true)) || body;
          res.setHeader('Cache-Control', 'no-store');
        }
      }
      res.writeHead(200, { 'Content-Type': mime[extension] });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end('Nenalezeno.');
    }
  };
  return http.createServer(async (req, res) => {
    try {
      if (new URL(req.url || '/', origin).pathname === hostingPolicyPath)
        return await serveHostingPolicy(req, res, () => runtimeRootPolicy(serve, origin));
      return await serve(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
}
if (import.meta.main) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  if (!process.env.SITETILLER_SITE_DIRECTORY || !process.env.SITETILLER_SITE_ORIGIN)
    throw Error('Set SITETILLER_SITE_DIRECTORY and SITETILLER_SITE_ORIGIN.');
  websiteServer(process.env.SITETILLER_SITE_DIRECTORY, process.env.SITETILLER_SITE_ORIGIN).listen(
    // Under the Shell's supervisor on a hidden port (documentation 2.6).
    Number(process.env.SITETILLER_LISTEN_PORT || process.env.PORT || 8080),
    process.env.HOST || '127.0.0.1',
  );
}
