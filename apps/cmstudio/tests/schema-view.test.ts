import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowLabel, groupFields, filterRows, rowSubtitle } from '../editor/schema-view.ts';
import type { Schema } from '../server/store.ts';
const schema: Schema = {
  version: 1,
  lists: {
    teams: {
      label: 'Týmy',
      key: 'slug',
      display: 'name',
      columns: { slug: { type: 'text', label: 'Klíč' }, name: { type: 'text', label: 'Jméno' } },
    },
    projects: {
      label: 'Projekty',
      key: 'ref',
      display: ['name', 'customer'],
      group: ['team', 'state'],
      columns: {
        ref: { type: 'text', label: 'Kód' },
        name: { type: 'text', label: 'Projekt' },
        customer: { type: 'text', label: 'Zákazník' },
        team: { type: 'list', label: 'Tým', list: 'teams' },
        state: { type: 'text', label: 'Stav' },
        brief: { type: 'html', label: 'Zadání' },
        notes: { type: 'html', label: 'Poznámky' },
      },
    },
  },
};
test('ED-16: Jiné kolekce bez title, section, code a page: názvy, více filtrů a vztahy', () => {
  const rows = [
    { ref: 'r1', name: 'Atlas', customer: 'Firma A', team: 'design', state: 'active', brief: '', notes: '' },
    { ref: 'r2', name: 'Boreal', customer: 'Firma B', team: 'dev', state: 'draft', brief: '', notes: '' },
  ];
  assert.equal(rowLabel(schema, 'projects', rows[0]), 'Atlas, Firma A');
  assert.deepEqual(
    groupFields(schema, 'projects').map((g) => g.key),
    ['team', 'state'],
  );
  assert.equal(filterRows(schema, 'projects', rows, { team: 'design', state: 'active' }, 'Firma A')[0].row.ref, 'r1');
  assert.equal(filterRows(schema, 'projects', rows, { team: 'design', state: 'draft' }, '').length, 0);
  assert.equal(
    rowSubtitle(schema, 'projects', rows[0], { teams: { rows: [{ slug: 'design', name: 'Designéři' }] } }),
    'Designéři · active',
  );
  assert.equal(
    rowLabel(
      { ...schema, lists: { ...schema.lists, projects: { ...schema.lists.projects, display: undefined } } },
      'projects',
      rows[0],
    ),
    'r1',
  );
});
