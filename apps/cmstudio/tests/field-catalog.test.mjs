import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fieldCatalog,
  canonicalFields,
  fieldAliases,
  fieldTypeLabels,
  supportedFieldTypes,
  fieldLimits,
} from '../field-catalog.ts';
import { validateStructure, fieldTypes, scalarProblem } from '../server/structure.ts';
import { validValuePattern } from '../server/generated-values.ts';
import { Store } from '../server/store.ts';
const make = (type, properties = {}) => ({
  version: 1,
  folders: { docs: { label: 'Docs', type: 'other' } },
  lists: {
    items: {
      label: 'Items',
      key: 'id',
      columns: { id: { type: 'text', label: 'ID' }, value: { type, label: 'Value', ...properties } },
    },
  },
});
const specific = {
  generated: { valuePattern: 'i-###' },
  list: { list: 'items' },
  file: { folder: 'docs' },
  media: { folder: 'docs' },
};
test('ST-06: catalog canonical selector, aliases and actual schema types stay in parity', () => {
  assert.equal(canonicalFields.length, 14);
  assert.equal(new Set(canonicalFields.map((f) => f.type)).size, 14);
  assert.deepEqual(
    Object.keys(fieldTypeLabels),
    canonicalFields.map((f) => f.type),
  );
  assert.deepEqual(fieldTypes, supportedFieldTypes);
  assert.deepEqual(Object.keys(fieldAliases).sort(), ['long_text', 'media', 'short_text']);
  for (const type of supportedFieldTypes)
    assert.doesNotThrow(() => validateStructure(make(type, specific[type] || {})));
  assert.throws(
    () => validateStructure(make('boolean')),
    (e) => e.status === 422,
  );
  for (const [alias, type] of Object.entries(fieldAliases)) assert.equal(typeof fieldTypeLabels[type], 'string');
  assert.equal(fieldCatalog.version, 1);
  assert.equal(fieldCatalog.limits, fieldLimits);
});
test('ST-06: catalog type-specific constraints match validators without strengthening unknown properties', () => {
  for (const type of ['text', 'textarea', 'short_text', 'long_text'])
    assert.doesNotThrow(() => validateStructure(make(type, { pattern: '[a-z]+' })));
  for (const type of supportedFieldTypes.filter(
    (type) => !['text', 'textarea', 'short_text', 'long_text'].includes(type),
  ))
    assert.throws(
      () => validateStructure(make(type, { ...specific[type], pattern: 'x' })),
      (e) => e.status === 422,
    );
  assert.throws(
    () => validateStructure(make('list', { list: 'absent' })),
    (e) => e.status === 422,
  );
  assert.throws(
    () => validateStructure(make('file', { folder: 'absent' })),
    (e) => e.status === 422,
  );
  assert.throws(
    () => validateStructure(make('checkbox', { default: true })),
    (e) => e.status === 422,
  );
  assert.throws(
    () => validateStructure(make('generated', { valuePattern: 'abc' })),
    (e) => e.status === 422,
  );
  assert.throws(
    () => validateStructure(make('generated', { valuePattern: 'i-#', default: '' })),
    (e) => e.status === 422,
  );
  assert.equal(validValuePattern('#'.repeat(fieldLimits.valuePatternLength)), true);
  assert.equal(validValuePattern('#'.repeat(fieldLimits.valuePatternLength + 1)), false);
  assert.doesNotThrow(() => validateStructure(make('text', { unrecognized: 'preserved' })));
  for (const [type, value] of [
    ['number', 'Infinity'],
    ['date', '2026-02-30'],
    ['time', '24:00'],
    ['checkbox', 'yes'],
  ])
    assert.notEqual(scalarProblem(type, value), '');
  for (const [type, value] of [
    ['number', '42'],
    ['date', '2026-10-11'],
    ['time', '23:59:59'],
    ['checkbox', 'true'],
  ])
    assert.equal(scalarProblem(type, value), '');
});
test('ST-06: catalog row shape/default/key/relation rules match actual stored validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'field-catalog-'));
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    const schema = make('checkbox');
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/items.json'), '[]');
    const store = new Store(root);
    assert.equal((await store.validateRows('items', [{ id: 'one' }]))[0].value, 'false');
    await assert.rejects(store.validateRows('items', [{ id: 'one', value: true }]), (e) => e.status === 422);
    await assert.rejects(store.validateRows('items', [{ id: 'one' }, { id: 'one' }]), (e) => e.status === 422);
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(make('list', { list: 'items' })));
    await assert.rejects(
      store.validateRows('items', [{ id: 'one', value: 'Label instead of key' }]),
      (e) => e.status === 422,
    );
    assert.equal(
      (await store.validateRows('items', [{ id: 'one', value: 'one' }], { items: [{ id: 'one', value: 'one' }] }))[0]
        .value,
      'one',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ST-06: a malformed collection is rejected with the exact problem and the catalog states the collection shape', () => {
  const reject = (definition, message) =>
    assert.throws(
      () => validateStructure({ version: 1, lists: { profile: definition }, folders: {} }),
      (e) => e.status === 422 && e.message.includes(message),
    );
  const fields = { code: { type: 'text', label: 'Kód' } };
  reject({ label: 'Profil', key: 'code', fields }, '"columns" (ne "fields")');
  reject({ label: ' ', key: 'code', columns: fields }, 'nemá název');
  reject({ label: 'Profil', key: 'id', columns: fields }, 'klíč (key)');
  assert.match(fieldCatalog.collectionRules.shape, /columns/);
});
