import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSiteUrl } from '../apps/aistudio/src/settings-site-url.ts';
import { publicUrl } from '../apps/aistudio/src/web-import.ts';
test('SH-09: settings accept explicit instance website address without relaxing importer URL rules', () => {
  assert.equal(settingsSiteUrl('http://127.0.0.1:4512/', 'http://127.0.0.1:4512/'), 'http://127.0.0.1:4512/');
  assert.equal(settingsSiteUrl('', 'http://127.0.0.1:4512/'), '');
  assert.equal(settingsSiteUrl('https://example.com/', 'http://127.0.0.1:4512/'), 'https://example.com/');
  assert.throws(() => settingsSiteUrl('http://127.0.0.1:4320/', 'http://127.0.0.1:4512/'));
  assert.throws(() => settingsSiteUrl('http://user:pass@127.0.0.1:4512/', 'http://127.0.0.1:4512/'));
  assert.throws(() => publicUrl('http://127.0.0.1:4512/'));
});
