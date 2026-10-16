import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { fieldCatalog } from '../apps/cmstudio/field-catalog.ts';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent } from '../apps/aistudio/src/cms-content-write.ts';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
test(
  'ST-06: Editor catalog reaches Studio source refresh, specialist and verifier; all canonical types/aliases owner-validated',
  { timeout: 90000 },
  async () => {
    const stack = await isolatedStack(),
      vars = [
        'SITETILLER_CMS_ROOT',
        'SITETILLER_CMS_URL',
        'SITETILLER_CMS_PUBLISHED_ROOT',
        'SITETILLER_PRODUCTION_DIRECTORY',
      ],
      previous = Object.fromEntries(vars.map((k) => [k, process.env[k]])),
      nativeFetch = global.fetch;
    process.env.SITETILLER_CMS_ROOT = stack.root;
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
    delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
    try {
      const working = await designCmsSource('unpublished'),
        published = await designCmsSource('published');
      for (const source of [working, published]) assert.deepEqual(source.context.fieldCatalog, fieldCatalog);
      assert.equal(working.context.permissions.schema, 'write');
      assert.equal(published.context.permissions.schema, 'read');
      const catalog = working.context.fieldCatalog,
        canonical = [
          'generated',
          'checkbox',
          'text',
          'textarea',
          'markdown',
          'html',
          'list',
          'file',
          'color',
          'url',
          'email',
          'number',
          'date',
          'time',
        ];
      assert.deepEqual(new Set(catalog.types.map((f) => f.type)), new Set(canonical));
      assert.deepEqual(catalog.aliases, { short_text: 'text', long_text: 'textarea', media: 'file' });
      const types = Object.fromEntries(catalog.types.map((f) => [f.type, f]));
      assert.equal(types.list.properties.list.reference, 'schema.lists');
      assert.match(types.list.valueRules.value, /targetCollection.key/);
      assert.equal(types.file.properties.folder.reference, 'schema.folders');
      assert.equal(types.generated.properties.valuePattern.contains, '#');
      assert.equal(types.generated.defaults.editorReadonly, true);
      const privateKeys = (value) =>
        value &&
        typeof value === 'object' &&
        Object.entries(value).some(
          ([key, child]) =>
            ['token', 'counters', 'manualValues', 'providers', 'masterKey'].includes(key) || privateKeys(child),
        );
      assert.ok(!privateKeys(catalog));
      const schema = structuredClone(working.context.schema),
        target = Object.keys(schema.lists)[0],
        folder = Object.keys(schema.folders)[0];
      schema.lists.catalogFixture = {
        key: 'record_key',
        label: 'Catalog fixture',
        columns: { record_key: { type: 'text', label: 'Key', extensionKept: 'existing supported passthrough' } },
      };
      for (const type of [...canonical, ...Object.keys(catalog.aliases)])
        schema.lists.catalogFixture.columns['field_' + type] = {
          type,
          label: type,
          ...(type === 'generated' ? { valuePattern: 'fixture-####', readonly: true } : {}),
          ...(type === 'list' ? { list: target } : {}),
          ...(['file', 'media'].includes(type) ? { folder } : {}),
        };
      const base = await contentBaseline(working),
        bad = structuredClone(schema);
      bad.lists.catalogFixture.columns.bad = { type: 'invented_widget', label: 'Unsupported' };
      const before = await readFile(join(stack.root, 'schema/structure.json'), 'utf8');
      await assert.rejects(
        applyDesignContent(base, { ...working.files, 'site/cms/structure.json': JSON.stringify(bad) }, false),
        { status: 422 },
      );
      assert.equal(await readFile(join(stack.root, 'schema/structure.json'), 'utf8'), before);
      const project = new Project(join(stack.root, '.sitetiller/project')),
        slots = [
          { provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
          { provider: 'anthropic', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
        ];
      let rounds = 0,
        specialist = false,
        verified = false;
      const result = await workflow(
        project,
        slots,
        'Use supported field types',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, instruction, input) => {
          assert.deepEqual(input.cms.fieldCatalog, catalog);
          if (input.testResults) {
            verified = true;
            return { value: { status: 'PASS', requiredFixes: [] } };
          }
          rounds++;
          if (rounds === 1) {
            assert.match(instruction, /cms.fieldCatalog/);
            return {
              value: { action: 'stage', files: [{ path: 'site/cms/structure.json', content: JSON.stringify(schema) }] },
            };
          }
          assert.ok(input.cms.schema.lists.catalogFixture);
          if (rounds === 2)
            return {
              value: {
                action: 'delegate',
                scope: 'edit',
                task: 'Confirm candidate',
                acceptance: [
                  { id: 'catalog', category: 'required', description: 'Supported types', basis: 'User request' },
                ],
                paths: ['site/index.html'],
              },
            };
          specialist = input.roleState.role === 'ui';
          return { value: { action: 'implement', files: [] } };
        },
        undefined,
        [],
        { cmsSource: 'unpublished', requestChecks: { technical: false, verification: true } },
      );
      assert.ok(result.commit && specialist && verified);
      const frozen = await project.committedFiles(result.commit),
        saved = JSON.parse(await readFile(join(stack.root, 'schema/structure.json'), 'utf8'));
      assert.deepEqual(JSON.parse(frozen['site/cms/structure.json']), saved);
      assert.equal(saved.lists.catalogFixture.columns.record_key.extensionKept, 'existing supported passthrough');
      assert.ok(!Object.keys(frozen).some((p) => p.includes('field-catalog')));
      assert.deepEqual((await designCmsSource('unpublished')).context.fieldCatalog, catalog);
      assert.deepEqual((await designCmsSource('published')).context.fieldCatalog, catalog);
      global.fetch = async (input, init) => {
        if (String(input).endsWith('/api/field-catalog')) return new Response('{}', { status: 503 });
        return nativeFetch(input, init);
      };
      await assert.rejects(
        designCmsSource('unpublished'),
        (error) => error.status === 502 && /Katalog typů polí/.test(error.message),
      );
    } finally {
      global.fetch = nativeFetch;
      for (const key of vars) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await stack.close();
    }
  },
);
