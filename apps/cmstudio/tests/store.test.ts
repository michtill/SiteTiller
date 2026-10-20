import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
test('ED-01: Validace vztahů, konfliktů, čistých dat, pořadí a záloh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'example-cms-'));
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    const schema = {
      version: 1,
      lists: {
        sections: {
          label: 'Oblasti',
          key: 'code',
          columns: {
            code: { type: 'text', label: 'Kód', required: true },
            title: { type: 'text', label: 'Název', maxlen: 20 },
          },
        },
        pages: {
          label: 'Stránky',
          key: 'page',
          columns: {
            page: { type: 'text', label: 'Kód', required: true },
            section: { type: 'list', label: 'Oblast', list: 'sections' },
          },
        },
      },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(
      join(root, 'data/sections.json'),
      JSON.stringify([
        { code: 'a', title: 'A' },
        { code: 'b', title: 'B' },
      ]),
    );
    await writeFile(join(root, 'data/pages.json'), JSON.stringify([{ page: 'p', section: 'a' }]));
    const store = new Store(root),
      start = await store.snapshot('sections');
    await assert.rejects(store.update('sections', [{ code: 'b', title: 'B' }], start.revision), /používá/);
    await assert.rejects(
      store.update('sections', [{ code: 'a', title: 'A', _id: '1' }], start.revision),
      /mimo schéma/,
    );
    await assert.rejects(
      store.update(
        'sections',
        [
          { code: 'a', title: 'A' },
          { code: 'a', title: 'B' },
        ],
        start.revision,
      ),
      /jedinečný/,
    );
    await assert.rejects(
      store.update(
        'sections',
        [
          { code: 'a', title: 'x'.repeat(21) },
          { code: 'b', title: 'B' },
        ],
        start.revision,
      ),
      /příliš dlouhý/,
    );
    const saved = await store.update(
      'sections',
      [
        { code: 'b', title: 'B' },
        { code: 'a', title: 'Změna' },
      ],
      start.revision,
    );
    assert.equal(saved.rows[0].code, 'b');
    assert.equal((await store.snapshot('pages')).rows[0].section, 'a');
    await assert.rejects(store.update('sections', start.rows, start.revision), /mezitím/);
    assert.equal((await readdir(join(root, 'backups'))).length, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'backups', (await readdir(join(root, 'backups')))[0]), 'utf8')),
      start.rows,
    );
    const p = await store.snapshot('pages');
    await assert.rejects(store.update('pages', [{ page: 'p', section: 'missing' }], p.revision), /neexistuje/);
    const results = await Promise.allSettled([
      store.update(
        'sections',
        [
          { code: 'a', title: 'První' },
          { code: 'b', title: 'B' },
        ],
        saved.revision,
      ),
      store.update(
        'sections',
        [
          { code: 'a', title: 'Druhá' },
          { code: 'b', title: 'B' },
        ],
        saved.revision,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        ...schema,
        lists: {
          ...schema.lists,
          'new-items': {
            label: 'Nová kolekce',
            key: 'ref',
            columns: { ref: { type: 'text', label: 'Kód', required: true } },
          },
        },
      }),
    );
    const empty = await store.snapshot('new-items');
    assert.deepEqual(empty.rows, []);
    await store.update('new-items', [{ ref: 'first' }], empty.revision);
    assert.deepEqual((await store.snapshot('new-items')).rows, [{ ref: 'first' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
