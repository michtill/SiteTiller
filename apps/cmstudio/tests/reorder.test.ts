import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorder } from '../editor/reorder.ts';
test('ED-15: Přetažení vloží položku před/za cíl a zachová zbytek pořadí', () => {
  const rows = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorder(rows, 0, 4), ['b', 'c', 'd', 'a']);
  assert.deepEqual(reorder(rows, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorder(rows, 0, 3), ['b', 'c', 'a', 'd']);
  assert.deepEqual(rows, ['a', 'b', 'c', 'd']);
  assert.equal(reorder(rows, 1, 2), rows);
  assert.equal(reorder(rows, -1, 2), rows);
});
