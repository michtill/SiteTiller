import test from 'node:test';
import assert from 'node:assert/strict';
import { editorFieldCatalog } from '../src/cms-field-catalog.ts';
const catalog = {
  version: 1,
  types: [
    { type: 'text', label: 'Text', purpose: 'Text', properties: [], valueRules: [], defaults: {}, readonlyRules: [] },
  ],
  aliases: { short_text: 'text' },
  commonProperties: [],
  collectionRules: [],
  limits: {},
  token: 'must not enter context',
  counters: { private: '1' },
};
test('ST-06: catalog loader keeps authoritative metadata and excludes response envelope extras', async () => {
  const result = await editorFieldCatalog(async (url) => {
    assert.match(url, /\/api\/field-catalog$/);
    return { ok: true, json: async () => catalog } as any;
  });
  assert.deepEqual(result.types, catalog.types);
  assert.ok(!Object.hasOwn(result, 'token'));
  assert.ok(!Object.hasOwn(result, 'counters'));
});
test('ST-06: missing or invalid catalog fails clearly without fallback types', async () => {
  for (const fetcher of [
    async () => {
      throw Error('offline');
    },
    async () => ({ ok: false, status: 404 }),
    async () => ({ ok: true, json: async () => ({ ...catalog, version: 2 }) }),
    async () => ({ ok: true, json: async () => ({ ...catalog, types: [] }) }),
  ])
    await assert.rejects(
      editorFieldCatalog(fetcher as any),
      (error) => error.status === 502 && /Katalog typů polí/.test(error.message),
    );
});
