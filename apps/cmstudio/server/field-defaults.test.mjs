import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStructure } from './structure.ts';
const withField = (field) => ({
  version: 1,
  folders: { docs: { label: 'Docs', type: 'other' } },
  lists: {
    items: {
      label: 'Items',
      key: 'id',
      columns: { id: { type: 'text', label: 'ID' }, value: { label: 'Value', ...field } },
    },
    other: { label: 'Other', key: 'id', columns: { id: { type: 'text', label: 'ID' } } },
  },
});
const saved = (field) => validateStructure(withField(field)).lists.items.columns.value;
test('ST-01: a default value is kept where it makes sense and checked like a value of the field', () => {
  for (const [type, value] of [
    ['checkbox', 'true'],
    ['text', 'Ahoj'],
    ['textarea', 'Řádek 1\nŘádek 2'],
    ['number', '10'],
    ['color', '#a1b2c3'],
    ['url', 'https://example.cz/'],
    ['email', 'info@example.cz'],
  ])
    assert.equal(saved({ type, default: value }).default, value, type);
  for (const [field, message] of [
    [{ type: 'number', default: 'deset' }, /není číslo/],
    [{ type: 'color', default: 'red' }, /#RRGGBB/],
    [{ type: 'url', default: 'example.cz' }, /webová adresa/],
    [{ type: 'email', default: 'info' }, /e-mail/],
    [{ type: 'text', pattern: '[a-z]+', default: 'ABC' }, /patternu/],
    [{ type: 'text', maxlen: 3, default: 'abcd' }, /délka/],
  ])
    assert.throws(() => saved(field), message, field.type);
});
test('ST-01: a default value is not kept for HTML, date, time, link and file fields', () => {
  for (const field of [
    { type: 'html', default: '<p>x</p>' },
    { type: 'date', default: '2026-10-15' },
    { type: 'time', default: '10:00' },
    { type: 'list', list: 'other', default: 'one' },
    { type: 'file', folder: 'docs', default: 'docs/a.pdf' },
  ])
    assert.equal(Object.hasOwn(saved(field), 'default'), false, field.type);
});
