import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
test('AI-05: structure HTTP dry-run and no-op keep live mode, actual disables it without publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-structure-api-'));
  let child;
  try {
    for (const dir of ['schema', 'data', 'media/docs']) await mkdir(join(root, dir), { recursive: true });
    const initial = {
      version: 1,
      folders: { docs: { label: 'Docs', type: 'other' } },
      lists: {
        items: {
          label: 'Items',
          key: 'id',
          columns: { id: { label: 'ID', type: 'text' }, title: { label: 'Title', type: 'text' } },
        },
      },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(initial));
    await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Published"}]');
    const listener = createServer();
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    const origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        SITETILLER_INSTANCE_ROOT: root,
        CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
        SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
        SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const get = async (path) => {
      const r = await fetch(origin + path);
      assert.equal(r.status, 200);
      return r.json();
    };
    let boot;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(origin + '/api/bootstrap');
        if (r.ok) {
          boot = await r.json();
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(boot);
    const call = async (path, body, method = 'POST', token = boot.token) => {
      const r = await fetch(origin + path, {
        method,
        headers: { Origin: origin, 'X-CMS-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal(
      (await call('/api/publication', { confirm: true, expectedRevision: boot.contentRevision })).status,
      200,
    );
    boot = await get('/api/bootstrap');
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 200);
    const pointer = await readFile(join(root, '.cms-publication/current.json'), 'utf8');
    const schema = structuredClone(initial);
    schema.lists.extras = {
      label: 'Extras',
      key: 'id',
      columns: { id: { label: 'ID', type: 'text' }, file: { label: 'File', type: 'file', folder: 'docs' } },
    };
    schema.lists.items.columns.status = { label: 'Status', type: 'text', default: 'Draft' };
    const body = {
      schema,
      schemaRevision: boot.schemaRevision,
      expectedRevision: boot.contentRevision,
      changes: [
        {
          collection: 'extras',
          revision: createHash('sha256').update('[]\n').digest('hex'),
          rows: [{ id: 'new', file: 'docs/new.txt' }],
        },
      ],
      assets: [{ folder: 'docs', name: 'new.txt', data: Buffer.from('new').toString('base64') }],
    };
    assert.equal((await call('/api/design-structure', body, 'POST', 'wrong')).status, 403);
    const dry = await call('/api/design-structure', { ...body, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.validated, true);
    assert.equal((await get('/api/edit-mode')).autoPublish, true);
    assert.equal((await get('/api/bootstrap')).contentRevision, boot.contentRevision);
    assert.equal(
      (
        await call('/api/design-structure', {
          schema: boot.schema,
          schemaRevision: boot.schemaRevision,
          expectedRevision: boot.contentRevision,
        })
      ).body.changed,
      false,
    );
    assert.equal((await get('/api/edit-mode')).autoPublish, true);
    const bad = structuredClone(body);
    bad.schema.lists.extras.key = 'missing';
    assert.equal((await call('/api/design-structure', bad)).status, 422);
    assert.equal((await get('/api/edit-mode')).autoPublish, true);
    const result = await call('/api/design-structure', body);
    assert.equal(result.status, 200);
    assert.equal(result.body.changed, true);
    assert.equal(result.body.schema.version, 2);
    assert.equal(result.body.lists.items.rows[0].status, 'Draft');
    assert.equal(result.body.lists.extras.rows[0].id, 'new');
    assert.equal((await get('/api/edit-mode')).autoPublish, false);
    await assert.rejects(readFile(join(root, 'settings/cmstudio.json')), (e) => e.code === 'ENOENT');
    assert.equal(await readFile(join(root, '.cms-publication/current.json'), 'utf8'), pointer);
    const published = await get('/api/published-bootstrap');
    assert.deepEqual(published.schema, initial);
    assert.equal(published.lists.items.rows[0].title, 'Published');
    assert.equal(published.schema.lists.extras, undefined);
    assert.equal((await call('/api/edit-mode', { autoPublish: true })).status, 409);
    assert.equal((await call('/api/design-structure', body)).status, 409);
    const next = await get('/api/bootstrap');
    assert.equal(next.contentRevision, result.body.contentRevision);
    assert.equal((await get('/api/publication')).unpublished, true);
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    await rm(root, { recursive: true, force: true });
  }
});
