import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { validateStructure, schemaSnapshot } from '../server/structure.ts';
import { writeDesignContent } from '../server/design-content.ts';
import { writeDesignStructure } from '../server/design-structure.ts';
import { restoreRevision, restoreDesignContent } from '../server/design-restore.ts';
import { generatedValue, sequencePath } from '../server/generated-values.ts';
const schema = {
  version: 1,
  folders: {},
  lists: {
    albums: {
      label: 'Albums',
      key: 'code',
      columns: {
        code: { label: 'Kód', type: 'generated', valuePattern: 'alb##', required: true },
        title: { label: 'Title', type: 'text', required: true },
      },
    },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'generated-'));
  for (const p of ['schema', 'data', 'media']) await mkdir(join(root, p));
  await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
  await writeFile(join(root, 'data/albums.json'), '[]\n');
  return root;
}
test('ST-03: patterns, minimum width, arbitrary precision and schema constraints', () => {
  assert.equal(generatedValue('alb##', 1n), 'alb01');
  assert.equal(generatedValue('alb##', 100n), 'alb100');
  assert.equal(generatedValue('abc-###', 1234n), 'abc-1234');
  assert.equal(generatedValue('x##-###', 1n), 'x01-001');
  assert.equal(generatedValue('a#', 9007199254740993123n), 'a9007199254740993123');
  for (const pattern of ['abc', '', undefined]) {
    const bad = structuredClone(schema);
    bad.lists.albums.columns.code.valuePattern = pattern;
    assert.throws(
      () => validateStructure(bad),
      (e) => e.status === 422,
    );
  }
  const bad = structuredClone(schema);
  bad.lists.albums.columns.code.default = 'abc';
  assert.throws(
    () => validateStructure(bad),
    (e) => e.status === 422,
  );
});
test('ST-03: locked concurrent creates, CAS retry, stable codes, delete no reuse and existing-value import', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      first = await store.snapshot('albums');
    const result = await Promise.allSettled([
      store.update('albums', [{ code: '', title: 'A' }], first.revision),
      store.update('albums', [{ code: '', title: 'B' }], first.revision),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(result.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 1);
    let current = await store.snapshot('albums');
    assert.equal(current.rows[0].code, 'alb01');
    await store.update('albums', [...current.rows, { code: '', title: 'Second' }], current.revision);
    current = await store.snapshot('albums');
    assert.equal(current.rows[1].code, 'alb02');
    await assert.rejects(
      store.update('albums', [...current.rows, { code: 'alb99', title: 'Manual' }], current.revision),
      (e) => e.status === 422,
    );
    const edited = current.rows.map((r) => ({ ...r, title: 'Edited' }));
    await store.update('albums', edited, current.revision);
    current = await store.snapshot('albums');
    assert.deepEqual(
      current.rows.map((r) => r.code),
      ['alb01', 'alb02'],
    );
    await store.update('albums', [], current.revision);
    current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'After delete' }], current.revision);
    assert.equal((await store.snapshot('albums')).rows[0].code, 'alb03');
    // Import/restore concrete values remains concrete; next allocation scans them.
    await writeFile(join(root, 'data/albums.json'), '[{"code":"alb120","title":"Imported"}]');
    current = await store.snapshot('albums');
    await store.update('albums', [...current.rows, { code: '', title: 'Next' }], current.revision);
    assert.equal((await store.snapshot('albums')).rows[1].code, 'alb121');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: AI dryrun spends nothing, commit shares generation, rollback restores private counter', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      body = {
        schemaRevision: (await schemaSnapshot(root)).revision,
        changes: [
          {
            collection: 'albums',
            revision: (await store.snapshot('albums')).revision,
            rows: [{ code: '', title: 'AI' }],
          },
        ],
      };
    const dry = await writeDesignContent(store, { ...body, dryRun: true });
    assert.equal(dry.lists.albums.rows[0].code, 'alb01');
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await assert.rejects(
      writeDesignContent(store, body, async () => {
        throw Error('fail');
      }),
      /fail/,
    );
    assert.deepEqual((await store.snapshot('albums')).rows, []);
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await writeDesignContent(store, body);
    assert.equal((await store.snapshot('albums')).rows[0].code, 'alb01');
    assert.equal(JSON.parse(await readFile(join(root, sequencePath), 'utf8')).counters.albums.code, '1');
    const revision = await restoreRevision(root),
      stateBefore = await readFile(join(root, sequencePath), 'utf8');
    // Frozen restore must not allocate or rewind sequence state.
    await restoreDesignContent(store, {
      schema,
      collections: { albums: [] },
      assets: [],
      expectedRevision: revision,
      dryRun: false,
    });
    assert.equal(await readFile(join(root, sequencePath), 'utf8'), stateBefore);
    const now = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'After restore' }], now.revision);
    assert.equal((await store.snapshot('albums')).rows[0].code, 'alb02');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: composed schema/row transaction generates new collection code, rollback and dryrun do not spend', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      next = structuredClone(schema);
    next.lists.newAlbums = {
      ...structuredClone(schema.lists.albums),
      columns: {
        ...structuredClone(schema.lists.albums.columns),
        code: { label: 'Kód', type: 'generated', valuePattern: 'newAlbums-####', required: true },
      },
    };
    const body = {
      schema: next,
      schemaRevision: (await schemaSnapshot(root)).revision,
      expectedRevision: await restoreRevision(root),
      changes: [
        {
          collection: 'newAlbums',
          revision: (await import('node:crypto')).createHash('sha256').update('[]\n').digest('hex'),
          rows: [{ code: '', title: 'New' }],
        },
      ],
    };
    const dry = await writeDesignStructure(store, { ...body, dryRun: true });
    assert.equal(dry.collections.newAlbums[0].code, 'newAlbums-0001');
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await assert.rejects(
      writeDesignStructure(store, body, async () => {
        throw Error('failed commit');
      }),
      /failed commit/,
    );
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    assert.deepEqual(await store.schema(), schema);
    const actual = await writeDesignStructure(store, body);
    assert.equal(actual.lists.newAlbums.rows[0].code, 'newAlbums-0001');
    assert.equal(JSON.parse(await readFile(join(root, sequencePath), 'utf8')).counters.newAlbums.code, '1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: host-normalized dryrun IDs commit unchanged; arbitrary or stale preview IDs reject', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      body = {
        schemaRevision: (await schemaSnapshot(root)).revision,
        changes: [
          {
            collection: 'albums',
            revision: (await store.snapshot('albums')).revision,
            rows: [{ code: '', title: 'Preview' }],
          },
        ],
      };
    const dry = await writeDesignContent(store, { ...body, dryRun: true });
    const normalized = { ...body, changes: body.changes.map((c) => ({ ...c, rows: dry.lists[c.collection].rows })) };
    await writeDesignContent(store, normalized);
    assert.equal((await store.snapshot('albums')).rows[0].code, 'alb01');
    await assert.rejects(writeDesignContent(store, normalized), (e) => e.status === 409);
    const current = await store.snapshot('albums');
    await assert.rejects(
      store.update('albums', [...current.rows, { code: 'alb999', title: 'Manual' }], current.revision),
      (e) => e.status === 422,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: non-key generated field is immutable; adding it leaves existing rows unchanged', async () => {
  const root = await fixture();
  try {
    const store = new Store(root);
    let current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'Existing' }], current.revision);
    const next = structuredClone(schema);
    next.lists.albums.columns.serial = { label: 'Serial', type: 'generated', valuePattern: 'seq-###' };
    await store.updateSchema(next, (await schemaSnapshot(root)).revision);
    current = await store.snapshot('albums');
    assert.equal(current.rows[0].code, 'alb01');
    assert.equal(current.rows[0].serial, '');
    await store.update('albums', [...current.rows, { code: '', title: 'New', serial: '' }], current.revision);
    current = await store.snapshot('albums');
    assert.equal(current.rows[1].code, 'alb02');
    assert.equal(current.rows[1].serial, 'seq-001');
    const changed = structuredClone(current.rows);
    changed[1].serial = 'seq-002';
    await assert.rejects(store.update('albums', changed, current.revision), (e) => e.status === 422);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: preview is readonly, repeatable and does not reserve numbers', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      { previewGeneratedValues } = await import('../server/generated-values.ts');
    const before = await restoreRevision(root),
      first = await previewGeneratedValues(store, 'albums'),
      again = await previewGeneratedValues(store, 'albums');
    assert.deepEqual(first.values, { code: 'alb01' });
    assert.deepEqual(again, first);
    assert.equal(await restoreRevision(root), before);
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    const current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'Other form' }], current.revision);
    const next = await previewGeneratedValues(store, 'albums');
    assert.deepEqual(next.values, { code: 'alb02' });
    assert.equal(next.collectionRevision, (await store.snapshot('albums')).revision);
    assert.equal(next.schemaRevision, (await schemaSnapshot(root)).revision);
    await assert.rejects(previewGeneratedValues(store, '../albums'), (e) => e.status === 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: editable custom values without proposed number preserve next, including matching pattern', async () => {
  const root = await fixture();
  try {
    const editable = structuredClone(schema);
    editable.lists.albums.columns.code.readonly = false;
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
    const store = new Store(root),
      { previewGeneratedValues } = await import('../server/generated-values.ts');
    let current = await store.snapshot('albums');
    await store.update('albums', [{ code: 'custom', title: 'Manual' }], current.revision);
    assert.deepEqual((await previewGeneratedValues(store, 'albums')).values, { code: 'alb01' });
    current = await store.snapshot('albums');
    await store.update('albums', [...current.rows, { code: 'alb99', title: 'Custom formatted' }], current.revision);
    assert.deepEqual((await previewGeneratedValues(store, 'albums')).values, { code: 'alb01' });
    const metadata = await readFile(join(root, sequencePath), 'utf8');
    await previewGeneratedValues(store, 'albums');
    assert.equal(await readFile(join(root, sequencePath), 'utf8'), metadata);
    const revision = await restoreRevision(root);
    await restoreDesignContent(store, {
      schema: editable,
      collections: { albums: [] },
      assets: [],
      expectedRevision: revision,
      dryRun: false,
    });
    assert.deepEqual((await previewGeneratedValues(store, 'albums')).values, { code: 'alb01' });
    current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'Default' }], current.revision);
    assert.equal((await store.snapshot('albums')).rows[0].code, 'alb01');
    current = await store.snapshot('albums');
    await store.update('albums', [...current.rows, { code: 'custom-002', title: 'Contains number' }], current.revision);
    assert.deepEqual((await previewGeneratedValues(store, 'albums')).values, { code: 'alb03' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: editable numeric tokens and non-key edits consume only on record creation', async () => {
  for (const [value, expected] of [
    ['custom1', 'alb02'],
    ['custom-001', 'alb02'],
    ['custom201', 'alb01'],
    ['alb01', 'alb02'],
  ]) {
    const root = await fixture();
    try {
      const editable = structuredClone(schema);
      editable.lists.albums.columns.code.readonly = false;
      await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
      const store = new Store(root),
        first = await store.snapshot('albums');
      await store.update('albums', [{ code: value, title: 'Custom' }], first.revision);
      assert.equal(
        (await (await import('../server/generated-values.ts')).previewGeneratedValues(store, 'albums')).values.code,
        expected,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await fixture();
  try {
    const editable = structuredClone(schema);
    editable.lists.albums.columns.serial = { label: 'Serial', type: 'generated', valuePattern: 'S##', readonly: false };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
    const store = new Store(root);
    let current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'New', serial: '' }], current.revision);
    current = await store.snapshot('albums');
    await store.update(
      'albums',
      current.rows.map((row) => ({ ...row, serial: 'S77' })),
      current.revision,
    );
    const preview = await (await import('../server/generated-values.ts')).previewGeneratedValues(store, 'albums');
    assert.equal(preview.values.serial, 'S02');
    assert.equal(preview.values.code, 'alb02');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: AI editable custom dryrun and rollback do not consume sequence', async () => {
  const root = await fixture();
  try {
    const editable = structuredClone(schema);
    editable.lists.albums.columns.code.readonly = false;
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
    const store = new Store(root),
      body = {
        schemaRevision: (await schemaSnapshot(root)).revision,
        changes: [
          {
            collection: 'albums',
            revision: (await store.snapshot('albums')).revision,
            rows: [{ code: 'alb99', title: 'Manual AI' }],
          },
        ],
      };
    const dry = await writeDesignContent(store, { ...body, dryRun: true });
    assert.equal(dry.lists.albums.rows[0].code, 'alb99');
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await assert.rejects(
      writeDesignContent(store, body, async () => {
        throw Error('fail');
      }),
      /fail/,
    );
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await writeDesignContent(store, body);
    assert.equal(
      (await (await import('../server/generated-values.ts')).previewGeneratedValues(store, 'albums')).values.code,
      'alb01',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: manual duplicate keys reject unchanged, automatic keys skip all occupied submitted values', async () => {
  const root = await fixture();
  try {
    const editable = structuredClone(schema);
    editable.lists.albums.columns.code.readonly = false;
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
    const store = new Store(root);
    let current = await store.snapshot('albums');
    await store.update('albums', [{ code: 'alb99', title: 'Manual' }], current.revision);
    current = await store.snapshot('albums');
    const before = await restoreRevision(root),
      metadata = await readFile(join(root, sequencePath), 'utf8');
    await assert.rejects(
      store.update('albums', [...current.rows, { code: 'alb99', title: 'Duplicate' }], current.revision),
      (e) => e.status === 422 && e.message.includes('alb99') && e.message.includes('již existuje'),
    );
    assert.equal(await restoreRevision(root), before);
    assert.equal(await readFile(join(root, sequencePath), 'utf8'), metadata);
    // Reserve explicit manual values even if they appear AFTER automatic rows.
    await store.update(
      'albums',
      [...current.rows, { code: '', title: 'Automatic' }, { code: 'alb01', title: 'Manual later' }],
      current.revision,
    );
    current = await store.snapshot('albums');
    assert.deepEqual(
      current.rows.map((r) => r.code),
      ['alb99', 'alb02', 'alb01'],
    );
    const { previewGeneratedValues } = await import('../server/generated-values.ts');
    assert.equal((await previewGeneratedValues(store, 'albums')).values.code, 'alb03');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: automatic unique keys skip consecutive occupied numbers without changing manual records', async () => {
  const root = await fixture();
  try {
    const editable = structuredClone(schema);
    editable.lists.albums.columns.code.readonly = false;
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(editable));
    const store = new Store(root);
    let current = await store.snapshot('albums');
    await store.update('albums', [{ code: '', title: 'First' }], current.revision);
    current = await store.snapshot('albums');
    await store.update(
      'albums',
      [...current.rows, ...[3, 4, 5].map((n) => ({ code: 'alb0' + n, title: 'Manual' }))],
      current.revision,
    );
    const { previewGeneratedValues } = await import('../server/generated-values.ts');
    assert.equal((await previewGeneratedValues(store, 'albums')).values.code, 'alb02');
    current = await store.snapshot('albums');
    await store.update('albums', [...current.rows, { code: '', title: 'Second' }], current.revision);
    assert.equal((await previewGeneratedValues(store, 'albums')).values.code, 'alb06');
    current = await store.snapshot('albums');
    await store.update('albums', [...current.rows, { code: '', title: 'After collisions' }], current.revision);
    const final = await store.snapshot('albums');
    assert.equal(final.rows.at(-1).code, 'alb06');
    assert.deepEqual(
      final.rows.slice(1, 4).map((r) => r.code),
      ['alb03', 'alb04', 'alb05'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: combined new collection duplicate diagnostic includes label/value and writes nothing', async () => {
  const root = await fixture();
  try {
    const store = new Store(root),
      next = structuredClone(schema);
    next.lists.uniqueCodes = {
      label: 'Unique codes',
      key: 'code',
      columns: { code: { label: 'Unique code', type: 'generated', valuePattern: 'uc-##', readonly: false } },
    };
    const body = {
      schema: next,
      schemaRevision: (await schemaSnapshot(root)).revision,
      expectedRevision: await restoreRevision(root),
      changes: [
        {
          collection: 'uniqueCodes',
          revision: (await import('node:crypto')).createHash('sha256').update('[]\n').digest('hex'),
          rows: [{ code: 'same' }, { code: 'same' }],
        },
      ],
    };
    const before = await restoreRevision(root);
    await assert.rejects(
      writeDesignStructure(store, body),
      (e) => e.status === 422 && e.message.includes('Unique code') && e.message.includes('"same"'),
    );
    assert.equal(await restoreRevision(root), before);
    await assert.rejects(readFile(join(root, sequencePath)), (e) => e.code === 'ENOENT');
    await assert.rejects(readFile(join(root, 'data/uniqueCodes.json')), (e) => e.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-03: editable for a new item: own value on creation, locked afterwards; without it the server assigns', async () => {
  const root = await fixture();
  try {
    const store = new Store(root);
    let current = await store.snapshot('albums');
    // Read-only without the option: the server assigns the value, an own one is refused.
    await assert.rejects(
      store.update('albums', [{ code: 'mine', title: 'Own' }], current.revision),
      /přiděluje server/,
    );
    const onCreate = structuredClone(schema);
    onCreate.lists.albums.columns.code.readonly = true;
    onCreate.lists.albums.columns.code.editableOnCreate = true;
    assert.equal(validateStructure(onCreate).lists.albums.columns.code.editableOnCreate, true);
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(onCreate));
    current = await store.snapshot('albums');
    await store.update(
      'albums',
      [
        { code: 'mine', title: 'Own' },
        { code: '', title: 'Assigned' },
      ],
      current.revision,
    );
    current = await store.snapshot('albums');
    assert.deepEqual(
      current.rows.map((r) => r.code),
      ['mine', 'alb01'],
    );
    // A saved record keeps its value (a non-key field; a changed key is another record).
    onCreate.lists.albums.columns.serial = {
      label: 'Serial',
      type: 'generated',
      valuePattern: 'S##',
      readonly: true,
      editableOnCreate: true,
    };
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(onCreate));
    current = await store.snapshot('albums');
    await store.update(
      'albums',
      [...current.rows, { code: '', title: 'Serial', serial: 'own-serial' }],
      current.revision,
    );
    current = await store.snapshot('albums');
    assert.equal(current.rows.at(-1).serial, 'own-serial');
    await assert.rejects(
      store.update(
        'albums',
        [...current.rows.slice(0, -1), { ...current.rows.at(-1), serial: 'changed' }],
        current.revision,
      ),
      /nelze měnit/,
    );
    assert.throws(
      () =>
        validateStructure({
          ...onCreate,
          lists: {
            albums: {
              ...onCreate.lists.albums,
              columns: {
                ...onCreate.lists.albums.columns,
                title: { label: 'Title', type: 'text', editableOnCreate: 'yes' },
              },
            },
          },
        }),
      /editableOnCreate|Title/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
