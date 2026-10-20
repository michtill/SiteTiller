import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { schemaSnapshot, recoverStructure } from '../server/structure.ts';
test('ST-01: Změna struktury zachová obsah, doplní výchozí hodnoty a chrání vztahy i souběžné změny', async () => {
  const root = await mkdtemp(join(tmpdir(), 'example-structure-'));
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await mkdir(join(root, 'media/docs'), { recursive: true });
    await writeFile(join(root, 'media/docs/test.txt'), 'document');
    const schema = {
      version: 1,
      folders: { docs: { label: 'Dokumenty', type: 'other' } },
      lists: {
        teams: {
          label: 'Týmy',
          key: 'code',
          columns: { code: { label: 'Kód', type: 'text', required: true }, name: { label: 'Název', type: 'text' } },
        },
        tasks: {
          label: 'Úkoly',
          key: 'id',
          group: ['team'],
          columns: {
            id: { label: 'ID', type: 'text', required: true },
            team: { label: 'Tým', type: 'list', list: 'teams' },
          },
        },
      },
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/teams.json'), JSON.stringify([{ code: 'a', name: 'Alpha' }]));
    await writeFile(join(root, 'data/tasks.json'), JSON.stringify([{ id: 't1', team: 'a' }]));
    const store = new Store(root),
      initial = await schemaSnapshot(root),
      content = await store.snapshot('teams'),
      originalData = await readFile(join(root, 'data/teams.json'), 'utf8');
    const change = (fn: (draft: any) => void) => {
      const draft = JSON.parse(JSON.stringify(schema));
      fn(draft);
      return draft;
    };
    await assert.rejects(
      store.updateSchema(
        change((s) => delete s.lists.teams.columns.name),
        initial.revision,
      ),
      /obsahuje data/,
    );
    assert.equal(await readFile(join(root, 'data/teams.json'), 'utf8'), originalData);
    await assert.rejects(
      store.updateSchema(
        change((s) => delete s.lists.tasks),
        initial.revision,
      ),
      /obsahuje záznamy/,
    );
    await assert.rejects(
      store.updateSchema(
        change((s) => delete s.lists.teams),
        initial.revision,
      ),
      /cílovou kolekci/,
    );
    await assert.rejects(
      store.updateSchema(
        change((s) => (s.lists.teams.columns.name.maxlen = 2)),
        initial.revision,
      ),
      /nový limit/,
    );
    await assert.rejects(
      store.updateSchema(
        change((s) => (s.lists.teams.columns.note = { label: 'Poznámka', type: 'text', required: true })),
        initial.revision,
      ),
      /prázdná/,
    );
    await assert.rejects(
      store.updateSchema(
        change((s) => delete s.folders.docs),
        initial.revision,
      ),
      /obsahuje soubory/,
    );
    const valid = change((s) => {
      s.lists.teams.columns.note = { label: 'Poznámka', type: 'text', required: true, default: 'Nová' };
      s.lists.projects = { label: 'Projekty', key: 'ref', columns: { ref: { label: 'Kód', type: 'text' } } };
      s.folders.images = { label: 'Obrázky', type: 'img' };
    });
    const saved = await store.updateSchema(valid, initial.revision);
    assert.equal(saved.schema.version, 2);
    assert.equal(saved.lists.teams.rows[0].note, 'Nová');
    assert.equal(saved.lists.tasks.rows[0].team, 'a');
    assert.deepEqual(saved.lists.projects.rows, []);
    assert.ok((await readdir(join(root, 'backups'))).some((f) => f.includes('structure')));
    await assert.rejects(store.updateSchema(valid, initial.revision), /mezitím/);
    await assert.rejects(
      store.update('teams', content.rows, content.revision, initial.revision),
      /Struktura se změnila/,
    );
    const rawSchema = await readFile(join(root, 'schema/structure.json'), 'utf8');
    await writeFile(
      join(root, '.structure-transaction.json'),
      JSON.stringify({ before: { 'schema/structure.json': rawSchema, 'data/temporary.json': null } }),
    );
    await writeFile(join(root, 'schema/structure.json'), '{}');
    await writeFile(join(root, 'data/temporary.json'), '[]');
    await recoverStructure(root);
    assert.equal(await readFile(join(root, 'schema/structure.json'), 'utf8'), rawSchema);
    await assert.rejects(readFile(join(root, 'data/temporary.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
