import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { scryptSync } from 'node:crypto';
import { Project } from '../src/project.ts';
const gateway = 'fixture-gateway-token';
test('HI-05: full restore requires warning confirmation, handles content conflicts and restores snapshots without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'full-restore-')),
    studio = join(root, 'studio'),
    cms = join(root, 'cms');
  let child: any, contentServer: any;
  try {
    await mkdir(cms, { recursive: true });
    const project = new Project(join(studio, 'project'));
    await project.init(null);
    const schema = {
      version: 1,
      lists: { items: { label: 'Items', key: 'id', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
      folders: { docs: { type: 'other' } },
    };
    const source = 'site/cms/files/docs/manual.pdf';
    await project.write({
      'site/cms/structure.json': JSON.stringify(schema),
      'site/cms/data/items.json': '[{"id":"one","title":"OLD"}]',
      'site/cms/snapshot.json': JSON.stringify({ version: 1, assets: { 'docs/manual.pdf': source } }),
      [source]: '[Binary content asset]',
    });
    await mkdir(join(project.root, 'site/cms/files/docs'), { recursive: true });
    await writeFile(join(project.root, source), '%PDF-1.4\nOLD');
    const old = await project.commit('Old complete step');
    await project.write({
      'site/index.html': (await project.files())['site/index.html'].replace('Nový web', 'New design'),
    });
    const head = await project.commit('New design');
    let revision = 'first',
      failCommit = false,
      actual = 0;
    const production = join(root, 'production.txt');
    await writeFile(production, 'PUBLISHED');
    contentServer = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/bootstrap') {
        res.end('{"token":"fixture"}');
        return;
      }
      if (req.url === '/api/design-restore-state') {
        res.end(JSON.stringify({ revision }));
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (body.expectedRevision !== revision || (!body.dryRun && failCommit)) {
        res.writeHead(409);
        res.end('{"error":"Content conflict"}');
        return;
      }
      assert.equal(body.schema.version, 1);
      assert.equal(body.collections.items[0].title, 'OLD');
      assert.equal(Buffer.from(body.assets[0].data, 'base64').toString(), '%PDF-1.4\nOLD');
      if (!body.dryRun) {
        actual++;
        await writeFile(join(cms, 'restored.json'), JSON.stringify(body));
        revision = 'restored';
      }
      res.end('{"autoPublish":false}');
    });
    await new Promise<void>((r) => contentServer.listen(0, '127.0.0.1', r));
    const password = 'fixture-password',
      salt = 'fixture-salt';
    await writeFile(
      join(studio, 'config.json'),
      JSON.stringify({
        password: { salt, hash: scryptSync(password, salt, 64).toString('hex') },
        requests: [
          { id: 'old-step', sequence: 1, status: 'ready', commit: old },
          { id: 'new-step', sequence: 2, status: 'ready', commit: head },
        ],
        slots: [],
        publishedCommit: null,
      }),
    );
    const port = 21400 + Math.floor(Math.random() * 150),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
      env: {
        ...process.env,
        SITETILLER_GATEWAY_TOKEN: gateway,
        SITETILLER_DATA_DIR: studio,
        SITETILLER_CMS_ROOT: cms,
        SITETILLER_CMS_URL: 'http://127.0.0.1:' + contentServer.address().port,
        SITETILLER_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready);
    const post = (path: string, body: any, cookie = '') =>
      fetch(origin + '/api/' + path, {
        method: 'POST',
        headers: { Origin: origin, 'x-sitetiller-gateway': cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const cookie = gateway;
    const prepared = await post('restore/prepare', { commit: old, expectedHead: head }, cookie).then((r) => r.json());
    assert.equal(prepared.hasContent, true);
    assert.equal(prepared.files, 1);
    const input = { commit: old, expectedHead: head, contentRevision: prepared.revision, confirmContentRestore: true };
    assert.equal((await post('restore', { ...input, confirmContentRestore: false }, cookie)).status, 422);
    assert.equal(await project.head(), head);
    revision = 'second';
    assert.equal((await post('restore', input, cookie)).status, 400);
    assert.equal(await project.head(), head);
    assert.equal(actual, 0);
    revision = 'first';
    failCommit = true;
    assert.equal((await post('restore', input, cookie)).status, 400);
    assert.equal(await project.head(), head);
    assert.equal(actual, 0);
    failCommit = false;
    const restored = await post('restore', input, cookie);
    assert.equal(restored.status, 200);
    const result = await restored.json();
    assert.equal(await project.head(), result.commit);
    assert.equal((await project.files())['site/cms/data/items.json'], '[{"id":"one","title":"OLD"}]');
    assert.equal(actual, 1);
    assert.equal(await readFile(production, 'utf8'), 'PUBLISHED');
  } finally {
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    if (contentServer) await new Promise<void>((r) => contentServer.close(r));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
