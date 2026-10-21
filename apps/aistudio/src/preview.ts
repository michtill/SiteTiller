import { savedDraft, namedDraftPreview } from './saved-drafts.ts';
import { snapshotAccessSecret, validSnapshotAccess } from './snapshot-access.ts';
import { studioPreviewPolicy } from './site-policy.ts';
import { cmsSnapshotAsset } from './cms-snapshot-asset.ts';
import { previewCmsFiles, previewCmsAsset, cmsPreviewAvailable } from './cms-preview.ts';
import { renderCmsPage } from './cms-render.ts';
import { serveForm } from './contact-forms.ts';
import { liveCms } from './cms-live.ts';
import { websitePolicy } from './site-policy.ts';
import { previewVersion, versionReferences } from './preview-version.ts';
import { previewDocument, previewLabel } from './preview-document.ts';
import { raster, binaryAsset, imageMime } from './images.ts';
import http from 'node:http';
import { extname } from 'node:path';
import { Project } from './project.ts';
import { resolveSiteFile } from './core.ts';
import { liveSnapshot } from './share-snapshot.ts';
const project = new Project((process.env.SITETILLER_DATA_DIR || '/data') + '/project', { objectReader: true });
export const frozenCache = 'private, max-age=31536000, immutable';
const mime: any = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.txt': 'text/plain',
  '.json': 'application/json',
};
http
  .createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200);
        return res.end('ok');
      }
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('User-agent: *\nDisallow: /\n');
      }
      let saved: any = null;
      if (url.pathname.startsWith('/drafts/')) {
        const match = url.pathname.match(/^\/drafts\/(draft-[a-f0-9]{32})\/access\/([0-9]{13}-[a-f0-9]{64})\//);
        if (!match) {
          res.writeHead(401);
          return res.end();
        }
        const record = await savedDraft(project, match[1]);
        if (!validSnapshotAccess(await snapshotAccessSecret(project), record.id, record.commit, match[2])) {
          res.writeHead(401);
          return res.end();
        }
        if (!['GET', 'HEAD'].includes(req.method || '')) {
          res.writeHead(405);
          return res.end();
        }
        const normalized = new URL(url);
        normalized.pathname = '/preview' + url.pathname;
        saved = await namedDraftPreview(project, normalized, record);
        if (saved) saved.prefix = saved.prefix.replace(/^\/preview/, '');
      }
      // A shared preview (documentation 4.10): the frozen state of a link whose step or saved draft still exists.
      if (url.pathname.startsWith('/shares/')) {
        const match = url.pathname.match(/^\/shares\/([a-f0-9]{32})\/(.*)$/),
          shared = match ? await liveSnapshot(project, match[1]) : null;
        if (!shared) {
          res.writeHead(404);
          return res.end();
        }
        saved = {
          project,
          commit: shared.commit,
          frozen: true,
          cmsMode: undefined,
          relative: decodeURIComponent(match![2]),
          prefix: '/shares/' + match![1] + '/',
          share: true,
        };
      }
      const version = saved || (await previewVersion(project, url));
      if (!version) {
        res.writeHead(404);
        return res.end('Verze nenalezena');
      }
      const { commit, relative, prefix } = version,
        selected = version.project || project,
        files = await selected.committedFiles(commit);
      if (
        await serveForm(req, res, relative, files, {
          preview: true,
          origin: new URL(req.url || '/', 'http://' + req.headers.host).origin,
        })
      )
        return;
      if (
        !version.frozen &&
        (version.cmsMode || (selected.root === project.root && commit === (await project.head())))
      ) {
        const live = version.cmsMode ? await previewCmsAsset(relative, version.cmsMode) : await liveCms(relative);
        if (live) {
          res.writeHead(live.status, {
            'Content-Type': live.mime,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': websitePolicy,
          });
          return res.end(req.method === 'HEAD' ? undefined : live.body);
        }
      }
      const snapshotAsset = cmsSnapshotAsset(relative, files),
        name = snapshotAsset || resolveSiteFile('/' + relative, files);
      if (!Object.hasOwn(files, name)) {
        res.writeHead(404);
        return res.end('Nenalezeno');
      }
      if (!snapshotAsset && !url.pathname.endsWith('/') && !Object.hasOwn(files, 'site/' + relative)) {
        res.writeHead(302, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      let content: any = binaryAsset(name) ? await selected.binary(commit, name) : files[name];
      if (name.endsWith('.html'))
        content =
          (await renderCmsPage(
            name,
            await previewCmsFiles(files, version.cmsMode),
            !version.frozen &&
              (version.cmsMode === 'unpublished' ||
                (!version.cmsMode && selected.root === project.root && commit === (await project.head()))),
          )) || content;
      if (/\.(html|css)$/.test(name) && prefix !== '/') content = versionReferences(content, prefix);
      if (name.endsWith('.html'))
        content = previewDocument(
          content,
          version.share ? '' : commit,
          url.searchParams.get('embedded') === '1',
          await previewLabel(project, version.share ? '' : commit, !!version.share),
        );
      res.setHeader('Content-Security-Policy', saved && !saved.share ? studioPreviewPolicy : websitePolicy);
      // A frozen version is addressed by its commit, so its responses never change.
      res.writeHead(200, {
        'Content-Type': raster(name)
          ? imageMime(name)
          : mime[extname(name).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': version.frozen ? frozenCache : 'no-store',
      });
      res.end(content);
    } catch {
      res.writeHead(503);
      res.end('Náhled se připravuje.');
    }
  })
  .listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1');
