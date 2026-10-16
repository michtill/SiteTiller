import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fieldCatalog } from '../../../cmstudio/field-catalog.ts';
import { workingContentRevision } from '../../../../packages/content/working-revision.mjs';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function contentFixtureServer(root: string) {
  let writes = 0;
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      const schema = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
      if (req.url === '/api/publication') return res.end(JSON.stringify({ unpublished: true }));
      if (req.url === '/api/field-catalog') return res.end(JSON.stringify(fieldCatalog));
      if (req.url === '/api/bootstrap') return res.end(JSON.stringify({ token: 'fixture' }));
      if (req.url === '/api/design-restore-state')
        return res.end(JSON.stringify({ revision: await workingContentRevision(root) }));
      if (!['/api/design-restore', '/api/design-content', '/api/design-structure'].includes(req.url || '')) {
        res.writeHead(404);
        return res.end('{}');
      }
      if (req.headers['x-cms-token'] !== 'fixture') throw Error('Missing owner token');
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (req.url === '/api/design-restore' || req.url === '/api/design-structure') {
        if (body.expectedRevision !== (await workingContentRevision(root))) {
          res.writeHead(409);
          return res.end('{"error":"Content conflict"}');
        }
      } else {
        if (body.schemaRevision !== hash(await readFile(join(root, 'schema/structure.json'), 'utf8'))) {
          res.writeHead(409);
          return res.end('{"error":"Schema conflict"}');
        }
        for (const change of body.changes) {
          if (change.revision !== hash(await readFile(join(root, 'data', change.collection + '.json'), 'utf8'))) {
            res.writeHead(409);
            return res.end('{"error":"Rows conflict"}');
          }
        }
      }
      const targetSchema = body.schema || schema,
        collections: any = {};
      for (const name of Object.keys(targetSchema.lists)) {
        collections[name] =
          body.collections?.[name] ||
          body.changes?.find((c: any) => c.collection === name)?.rows ||
          JSON.parse(await readFile(join(root, 'data', name + '.json'), 'utf8'));
      }
      if (!body.dryRun) {
        writes++;
        if (body.schema) await writeFile(join(root, 'schema/structure.json'), JSON.stringify(body.schema));
        for (const [name, rows] of Object.entries(collections))
          await writeFile(join(root, 'data', name + '.json'), JSON.stringify(rows));
        for (const asset of body.assets || []) {
          // A file sent only as its digest equals the working one and stays as it is.
          if (asset.data === undefined) continue;
          await mkdir(join(root, 'media', asset.folder), { recursive: true });
          await writeFile(join(root, 'media', asset.folder, asset.name), Buffer.from(asset.data, 'base64'));
        }
      }
      const lists = Object.fromEntries(
        Object.entries(collections).map(([name, rows]) => [name, { rows, revision: hash(JSON.stringify(rows)) }]),
      );
      res.end(
        JSON.stringify({
          schema: targetSchema,
          schemaRevision: hash(JSON.stringify(targetSchema)),
          collections,
          lists,
          contentRevision: await workingContentRevision(root),
          autoPublish: false,
        }),
      );
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    origin: 'http://127.0.0.1:' + (server.address() as any).port,
    get writes() {
      return writes;
    },
  };
}
