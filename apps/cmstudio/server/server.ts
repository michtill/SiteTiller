import { fieldCatalog } from '../field-catalog.ts';
import { previewGeneratedValues } from './generated-values.ts';
import { writeDesignStructure } from './design-structure.ts';
import { discardChanges } from './discard-changes.ts';
import { designRestoreState, restoreDesignContent, recoverDesignRestore, restoreRevision } from './design-restore.ts';
import { mediaUsage, deleteMedia } from './media-delete.ts';
import { uploadName, folderMaxBytes, folderMaxMb } from './file-upload.ts';
import { writeDesignContent } from './design-content.ts';
import { Publication } from './publication.ts';
import { SettingsStore } from './settings.ts';
import http from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';

import { randomUUID } from 'node:crypto';
import { Store, Problem } from './store.ts';
import { schemaSnapshot, recoverStructure } from './structure.ts';
if (!process.env.SITETILLER_INSTANCE_ROOT) throw Error('SITETILLER_INSTANCE_ROOT is required');
if (!process.env.CMS_DIST) throw Error('CMS_DIST is required');
const distRoot = resolve(process.env.CMS_DIST),
  root = resolve(process.env.SITETILLER_INSTANCE_ROOT),
  store = new Store(root),
  port = Number(process.env.PORT || 4510),
  origin = `http://127.0.0.1:${port}`,
  token = randomUUID();
await recoverDesignRestore(root);
for (const folder of ['schema', 'data', 'media']) await mkdir(join(root, folder), { recursive: true });
try {
  await writeFile(
    join(root, 'schema/structure.json'),
    JSON.stringify({ version: 1, lists: {}, folders: {} }, null, 2) + '\n',
    { flag: 'wx' },
  );
} catch (e: any) {
  if (e.code !== 'EEXIST') throw e;
}
await recoverStructure(root);
const publication = new Publication(root, store);
async function sharedLook() {
  let shared: any = {};
  try {
    shared = JSON.parse(
      await readFile(process.env.SITETILLER_SHARED_SETTINGS_FILE || join(root, 'settings/shared.json'), 'utf8'),
    );
  } catch {}
  return {
    language: shared?.language === 'en' ? 'en' : 'cs',
    theme: ['green', 'blue', 'plum', 'graphite', 'sand', 'black', 'light'].includes(shared?.theme)
      ? shared.theme
      : 'green',
  };
}
const editorSettings = new SettingsStore(root, { sharedFile: process.env.SITETILLER_SHARED_SETTINGS_FILE });
await publication.initialize();
// The edit mode lives in memory until a restart. When the Editor is first used it takes the default from the Shared
// settings; live editing starts only when nothing is unpublished.
let editMode: boolean | undefined;
async function currentEditMode() {
  editMode ??= (await editorSettings.liveByDefault()) && !(await publication.status()).unpublished;
  return editMode;
}
// A real write from AI Studio ends live editing for this run; the default in the Shared settings stays.
async function disableDesignLive() {
  editMode = false;
  return { autoPublish: false };
}
async function afterSave() {
  if (await currentEditMode()) {
    try {
      await publication.publish(currentEditMode);
    } catch {
      return 'Data jsou uložena, ale publikování selhalo. Zkuste Publikovat úpravy.';
    }
  }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};
function inside(base: string, path: string) {
  const result = resolve(base, path),
    rel = relative(base, result);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Problem(400, 'Neplatná cesta.');
  return result;
}
async function mediaFiles(folder = join(root, 'media'), prefix = ''): Promise<string[]> {
  const items = await readdir(folder, { withFileTypes: true });
  return (
    await Promise.all(
      items.map(async (i) =>
        i.isSymbolicLink()
          ? []
          : i.isDirectory()
            ? mediaFiles(join(folder, i.name), prefix + i.name + '/')
            : [prefix + i.name],
      ),
    )
  ).flat();
}
http
  .createServer(async (req, res) => {
    function json(status: number, value: unknown) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    }
    try {
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
        throw new Problem(403, 'Neplatný hostitel.');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'self'",
      );
      const url = new URL(req.url || '/', origin);
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        if (
          ![origin, `http://localhost:${port}`].includes(req.headers.origin || '') ||
          req.headers['x-cms-token'] !== token
        )
          throw new Problem(403, 'Neplatný požadavek.');
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const result = await store.exclusive(async () => {
          const snapshot = await schemaSnapshot(root);
          return {
            schema: snapshot.schema,
            schemaRevision: snapshot.revision,
            ...(await editorSettings.snapshot()),
            lists: await store.all(),
            token,
            media: await mediaFiles(),
            contentRevision: await restoreRevision(root),
            autoPublish: await currentEditMode(),
          };
        });
        return json(200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/published-bootstrap') {
        const result = await store.exclusive(async () => {
          const published = await publication.syncProduction();
          if (!published) throw new Problem(404, 'Zatím neexistuje publikovaný obsah.');
          const schemaText = await readFile(join(published.directory, 'schema/structure.json'), 'utf8'),
            schema = JSON.parse(schemaText),
            lists: Record<string, any> = {};
          for (const name of Object.keys(schema.lists)) {
            const text = await readFile(join(published.directory, 'data', name + '.json'), 'utf8');
            lists[name] = {
              rows: JSON.parse(text),
              revision: (await import('node:crypto')).createHash('sha256').update(text).digest('hex'),
            };
          }
          return {
            schema,
            schemaRevision: published.revision,
            lists,
            media: await mediaFiles(join(published.directory, 'media')).catch((e) => {
              if (e.code === 'ENOENT') return [];
              throw e;
            }),
            contentRevision: published.revision,
            ...(await editorSettings.snapshot()),
            token,
            autoPublish: await currentEditMode(),
          };
        });
        return json(200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/field-catalog') return json(200, fieldCatalog);
      if (req.method === 'GET' && url.pathname === '/api/generated-values')
        return json(200, await previewGeneratedValues(store, url.searchParams.get('collection') || ''));
      if (req.method === 'GET' && url.pathname === '/api/edit-mode')
        return json(200, { autoPublish: await currentEditMode() });
      if (req.method === 'POST' && url.pathname === '/api/edit-mode') {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1000) throw new Problem(413, 'Příliš velký požadavek.');
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        if (typeof body.autoPublish !== 'boolean') throw new Problem(422, 'Neplatný režim editace.');
        if (body.autoPublish && (await publication.status()).unpublished)
          throw new Problem(409, 'Živou editaci lze zapnout až po publikování všech úprav.');
        editMode = body.autoPublish;
        return json(200, { autoPublish: editMode });
      }
      if (req.method === 'GET' && url.pathname === '/api/publication') return json(200, await publication.status());
      // Cheap periodic check: the client loads the full bootstrap only when the revision changes.
      if (req.method === 'GET' && url.pathname === '/api/revision') {
        const status = await publication.status();
        return json(200, {
          contentRevision: await store.exclusive(() => restoreRevision(root)),
          publication: status,
          autoPublish: await currentEditMode(),
        });
      }
      if (req.method === 'POST' && ['/api/publication', '/api/discard-changes'].includes(url.pathname)) {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 2000) throw new Problem(413, 'Příliš velký požadavek.');
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        if (
          !body ||
          body.confirm !== true ||
          typeof body.expectedRevision !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.expectedRevision) ||
          Object.keys(body).some((k) => !['confirm', 'expectedRevision'].includes(k))
        )
          throw new Problem(422, 'Potvrďte akci a znovu načtěte aktuální stav.');
        return json(
          200,
          url.pathname === '/api/publication'
            ? await publication.publish(undefined, body.expectedRevision)
            : await discardChanges(store, publication, body, disableDesignLive),
        );
      }

      if (req.method === 'GET' && url.pathname.startsWith('/published/')) {
        const asset = await publication.asset(decodeURIComponent(url.pathname.slice(11)));
        res.writeHead(200, { 'Content-Type': mime[extname(asset.path)] || 'application/octet-stream' });
        return res.end(asset.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/design-restore-state')
        return json(200, await designRestoreState(store));
      if (req.method === 'POST' && url.pathname === '/api/design-restore') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 35 * 1024 * 1024) throw new Problem(413, 'Příliš velký obsah.');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        return json(200, await restoreDesignContent(store, body, disableDesignLive));
      }
      if (req.method === 'POST' && url.pathname === '/api/design-structure') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 35 * 1024 * 1024) throw new Problem(413, 'Struktura a obsah jsou příliš velké.');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        return json(200, await writeDesignStructure(store, body, disableDesignLive));
      }
      if (req.method === 'POST' && url.pathname === '/api/design-content') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 35 * 1024 * 1024) throw new Problem(413, 'Příliš velký obsah.');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        return json(200, await writeDesignContent(store, body, disableDesignLive));
      }
      if (req.method === 'GET' && url.pathname === '/api/brand')
        return json(200, { name: (await editorSettings.snapshot()).settings.name });
      if (req.method === 'PUT' && url.pathname === '/api/structure') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Problem(413, 'Struktura je příliš velká.');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        const result = await store.updateSchema(body.schema, body.revision);
        return json(200, { ...result, publicationWarning: await afterSave() });
      }
      if (req.method === 'GET' && url.pathname === '/api/media-usage')
        return json(200, { usage: await store.exclusive(() => mediaUsage(store, url.searchParams.get('path') || '')) });
      if (req.method === 'DELETE' && url.pathname === '/api/media') {
        const result = await deleteMedia(store, url.searchParams.get('path') || '');
        return json(200, { ...result, publicationWarning: await afterSave() });
      }
      if (req.method === 'GET' && url.pathname === '/api/collection-removal') {
        const name = url.searchParams.get('collection') || '';
        return json(
          200,
          await store.exclusive(async () => {
            const schema = await store.schema();
            if (!Object.hasOwn(schema.lists, name)) throw new Problem(404, 'Neznámá kolekce.');
            return {
              count: (await store.snapshot(name)).rows.length,
              references: Object.entries(schema.lists).flatMap(([key, def]) =>
                key === name
                  ? []
                  : Object.values(def.columns)
                      .filter((f) => f.type === 'list' && f.list === name)
                      .map((f) => def.label + ' / ' + f.label),
              ),
            };
          }),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/media') return json(200, await mediaFiles());
      if (req.method === 'PUT' && /^\/api\/lists\/[\w-]+$/.test(url.pathname)) {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 10 * 1024 * 1024) throw new Problem(413, 'Příliš velký obsah.');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Problem(400, 'Neplatný JSON.');
        }
        const result = await store.update(
          url.pathname.split('/').at(-1)!,
          body.rows,
          body.revision,
          typeof body.schemaRevision === 'string' ? body.schemaRevision : '',
        );
        return json(200, { ...result, publicationWarning: await afterSave() });
      }
      if (req.method === 'POST' && url.pathname === '/api/media') {
        const raw = url.searchParams.get('name') || '',
          name = raw.normalize('NFC'),
          requestedFolder = url.searchParams.get('folder') || '',
          schema = await store.schema();
        const folder = requestedFolder,
          definition =
            requestedFolder && Object.hasOwn(schema.folders || {}, requestedFolder)
              ? schema.folders?.[requestedFolder]
              : undefined;
        if (!/^[\w-]+$/.test(folder) || !definition) throw new Problem(422, 'Vyberte složku definovanou ve schématu.');
        uploadName(definition.type, name);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > folderMaxBytes(definition))
            throw new Problem(413, 'Soubor překročil ' + folderMaxMb(definition) + ' MB.');
          chunks.push(chunk);
        }
        const path = folder + '/' + randomUUID().slice(0, 8) + '-' + name;
        await store.exclusive(async () => {
          const current = await store.schema();
          if (!Object.hasOwn(current.folders || {}, folder) || current.folders![folder].type !== definition.type)
            throw new Problem(409, 'Složka se změnila. Znovu načtěte editor.');
          await mkdir(inside(join(root, 'media'), folder), { recursive: true });
          await writeFile(inside(join(root, 'media'), path), Buffer.concat(chunks));
        });
        return json(201, { path, publicationWarning: await afterSave() });
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) throw new Problem(405, 'Nepovolená metoda.');
      const nativeMedia = url.pathname.startsWith('/media/'),
        folderMedia = Object.hasOwn((await store.schema()).folders || {}, url.pathname.split('/')[1]),
        media = nativeMedia || folderMedia;
      const file = media
        ? inside(join(root, 'media'), decodeURIComponent(url.pathname.slice(nativeMedia ? 7 : 1)))
        : inside(
            distRoot,
            ['/', '/structure'].includes(url.pathname) ? 'index.html' : decodeURIComponent(url.pathname.slice(1)),
          );
      if (!(await stat(file)).isFile()) throw new Problem(404, 'Soubor nenalezen.');
      res.writeHead(200, {
        'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
        ...(media ? { 'Content-Disposition': `inline` } : {}),
      });
      if (req.method === 'HEAD') return res.end();
      // The page carries the interface language and colour theme of the common settings.
      if (!media && file === join(distRoot, 'index.html')) {
        const look = await sharedLook();
        return res.end(
          (await readFile(file, 'utf8')).replace(
            /<html\b[^>]*>/i,
            '<html lang="' +
              look.language +
              '" data-shared-language="' +
              look.language +
              '" data-cms-theme="' +
              look.theme +
              '">',
          ),
        );
      }
      res.end(await readFile(file));
    } catch (error: any) {
      json(error instanceof Problem ? error.status : error.code === 'ENOENT' ? 404 : 500, {
        error:
          error instanceof Problem
            ? error.message
            : error.code === 'ENOENT'
              ? 'Soubor nenalezen.'
              : 'Operace se nezdařila.',
      });
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`SiteTiller CMStudio: ${origin}`));
