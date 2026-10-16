import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { schemaSnapshot } from './structure.ts';
import { writeDesignContent, commitWorkingTransaction } from './design-content.ts';
test('AI-05: batch validates joint relations, detects conflicts and protects other layers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-batch-'));
  try {
    for (const d of ['schema', 'data', 'backups', 'settings', 'media', '.cms-publication']) await mkdir(join(root, d));
    const schema = {
      version: 1,
      lists: {
        parents: { key: 'id', label: 'Parents', columns: { id: { type: 'text', label: 'ID' } } },
        children: {
          key: 'id',
          label: 'Children',
          columns: {
            id: { type: 'text', label: 'ID' },
            parent: { type: 'list', list: 'parents', label: 'Parent' },
            url: { type: 'url', label: 'URL' },
          },
        },
      },
      folders: {},
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/parents.json'), '[{"id":"a"}]');
    await writeFile(join(root, 'data/children.json'), '[{"id":"c","parent":"a","url":"https://example.com"}]');
    for (const p of ['settings/cmstudio.json', 'media/file.txt', '.cms-publication/current.json'])
      await writeFile(join(root, p), 'protected');
    const store = new Store(root),
      original = await store.all(),
      revision = (await schemaSnapshot(root)).revision,
      body = {
        schemaRevision: revision,
        changes: [
          { collection: 'parents', revision: original.parents.revision, rows: [{ id: 'b' }] },
          {
            collection: 'children',
            revision: original.children.revision,
            rows: [{ id: 'c', parent: 'b', url: 'https://example.com' }],
          },
        ],
      };
    const before = await readFile(join(root, 'data/parents.json'), 'utf8');
    await writeDesignContent(store, { ...body, dryRun: true });
    assert.equal(await readFile(join(root, 'data/parents.json'), 'utf8'), before);
    await assert.rejects(writeDesignContent(store, { ...body, schemaRevision: 'stale' }), (e) => e.status === 409);
    await assert.rejects(
      writeDesignContent(store, {
        ...body,
        changes: [{ ...body.changes[1], rows: [{ id: 'c', parent: 'missing', url: 'javascript:bad' }] }],
      }),
      (e) => e.status === 422,
    );
    await assert.rejects(writeDesignContent(store, { ...body, settings: {} }), (e) => e.status === 422);
    await writeDesignContent(store, body);
    assert.equal((await store.snapshot('children')).rows[0].parent, 'b');
    await assert.rejects(writeDesignContent(store, body), (e) => e.status === 409);
    for (const p of ['settings/cmstudio.json', 'media/file.txt', '.cms-publication/current.json'])
      assert.equal(await readFile(join(root, p), 'utf8'), 'protected');
    const oldP = await readFile(join(root, 'data/parents.json'), 'utf8'),
      oldC = await readFile(join(root, 'data/children.json'), 'utf8');
    let n = 0;
    await assert.rejects(
      commitWorkingTransaction(
        root,
        { 'data/parents.json': '[]', 'data/children.json': '[]' },
        { 'data/parents.json': oldP, 'data/children.json': oldC },
        async (path, text) => {
          if (++n === 2) throw Error('Injected disk failure');
          await writeFile(path, text);
        },
      ),
      /disk failure/,
    );
    assert.equal(await readFile(join(root, 'data/parents.json'), 'utf8'), oldP);
    assert.equal(await readFile(join(root, 'data/children.json'), 'utf8'), oldC);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
