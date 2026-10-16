import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent, normalizeContentPlan } from '../apps/aistudio/src/cms-content-write.ts';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
test(
  'AI-29: AI generated code: blank proposal, normalized preview, atomic save, frozen snapshot, guarded follow-up',
  { timeout: 90000 },
  async () => {
    const stack = await isolatedStack(),
      vars = [
        'SITETILLER_CMS_ROOT',
        'SITETILLER_CMS_URL',
        'SITETILLER_CMS_PUBLISHED_ROOT',
        'SITETILLER_PRODUCTION_DIRECTORY',
      ],
      previous = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
    process.env.SITETILLER_CMS_ROOT = stack.root;
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
    delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
    try {
      const source = await designCmsSource('unpublished'),
        schema = structuredClone(source.context.schema),
        pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8');
      schema.lists.albums = {
        key: 'code',
        label: 'Albums',
        display: ['title'],
        columns: {
          code: { type: 'generated', label: 'Code', required: true, valuePattern: 'albums-####' },
          serial: { type: 'generated', label: 'Serial', valuePattern: 'x##-###' },
          title: { type: 'text', label: 'Title' },
        },
      };
      const project = new Project(join(stack.root, '.sitetiller/project')),
        slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }];
      const result = await workflow(
        project,
        slots,
        'Add albums collection',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, instruction, input) => {
          assert.match(instruction, /valuePattern/);
          assert.match(input.cms.instruction, /never re-key/);
          return {
            value: {
              action: 'implement',
              files: [
                { path: 'site/cms/structure.json', content: JSON.stringify(schema) },
                {
                  path: 'site/cms/data/albums.json',
                  content: JSON.stringify([{ code: '', serial: '', title: 'First' }]),
                },
              ],
            },
          };
        },
        undefined,
        [],
        { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
      );
      assert.ok(result.commit);
      const actual = JSON.parse(await readFile(join(stack.root, 'data/albums.json'), 'utf8')),
        frozen = await project.committedFiles(result.commit);
      assert.equal(actual[0].code, 'albums-0001');
      assert.equal(actual[0].serial, 'x01-001');
      assert.deepEqual(JSON.parse(frozen['site/cms/data/albums.json']), actual);
      assert.ok(!Object.keys(frozen).some((p) => p.includes('sequences')));
      assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
      const current = await designCmsSource('unpublished'),
        baseline = await contentBaseline(current),
        path = 'site/cms/data/albums.json',
        files = { ...current.files, [path]: JSON.stringify([...actual, { code: '', serial: '', title: 'Second' }]) },
        sequencePath = join(stack.root, '.cmstudio-sequences.json'),
        sequenceBefore = await readFile(sequencePath, 'utf8');
      const dry = await applyDesignContent(baseline, files, true);
      assert.equal(await readFile(sequencePath, 'utf8'), sequenceBefore);
      normalizeContentPlan(files, dry);
      assert.equal(JSON.parse(files[path])[1].code, 'albums-0002');
      assert.equal(JSON.parse(files[path])[1].serial, 'x02-002');
      const saved = await applyDesignContent(baseline, files, false);
      normalizeContentPlan(files, saved);
      assert.deepEqual(
        JSON.parse(files[path]),
        JSON.parse(await readFile(join(stack.root, 'data/albums.json'), 'utf8')),
      );
      assert.equal(JSON.parse((await project.committedFiles(result.commit))[path]).length, 1);
      const fresh = await designCmsSource('unpublished'),
        base = await contentBaseline(fresh),
        rows = JSON.parse(fresh.files[path]),
        unchanged = await readFile(join(stack.root, 'data/albums.json'), 'utf8'),
        counter = await readFile(sequencePath, 'utf8');
      for (const change of [
        () => {
          const r = structuredClone(rows);
          r[0].serial = 'x99-099';
          return r;
        },
        () => [...rows, { code: 'albums-9999', serial: '', title: 'Manual' }],
      ]) {
        await assert.rejects(applyDesignContent(base, { ...fresh.files, [path]: JSON.stringify(change()) }, false), {
          status: 422,
        });
        assert.equal(await readFile(join(stack.root, 'data/albums.json'), 'utf8'), unchanged);
        assert.equal(await readFile(sequencePath, 'utf8'), counter);
      }
      const next = { ...fresh.files, [path]: JSON.stringify([...rows, { code: '', serial: '', title: 'Third' }]) };
      normalizeContentPlan(next, await applyDesignContent(base, next, true));
      const advanced = JSON.parse(counter);
      advanced.counters.albums.code = '3';
      advanced.counters.albums.serial = '3';
      await writeFile(sequencePath, JSON.stringify(advanced));
      const advancedBytes = await readFile(sequencePath, 'utf8');
      await assert.rejects(applyDesignContent(base, next, false), { status: 422 });
      assert.equal(await readFile(join(stack.root, 'data/albums.json'), 'utf8'), unchanged);
      assert.equal(await readFile(sequencePath, 'utf8'), advancedBytes);
      await writeFile(sequencePath, counter);
      const concurrent = {
        ...fresh.files,
        [path]: JSON.stringify(rows.map((r, i) => (i ? r : { ...r, title: 'Concurrent owner' }))),
      };
      await applyDesignContent(base, concurrent, false);
      const owner = await readFile(join(stack.root, 'data/albums.json'), 'utf8'),
        ownerCounter = await readFile(sequencePath, 'utf8');
      await assert.rejects(applyDesignContent(base, next, false), { status: 409 });
      assert.equal(await readFile(join(stack.root, 'data/albums.json'), 'utf8'), owner);
      assert.equal(await readFile(sequencePath, 'utf8'), ownerCounter);
      const head = await project.head(),
        blocked = await workflow(
          project,
          slots,
          'Add generated published collection',
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          async () => ({
            value: {
              action: 'implement',
              files: [{ path: 'site/cms/structure.json', content: JSON.stringify(schema) }],
            },
          }),
          undefined,
          [],
          { cmsSource: 'published', requestChecks: { technical: false, verification: false } },
        );
      assert.equal(blocked.conversationOnly, true);
      assert.equal(await project.head(), head);
      assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
    } finally {
      for (const key of vars) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await stack.close();
    }
  },
);

test(
  'AI-29: AI editable generated override honors whole numeric tokens, readonly defaults and frozen snapshots',
  { timeout: 90000 },
  async () => {
    const stack = await isolatedStack(),
      vars = [
        'SITETILLER_CMS_ROOT',
        'SITETILLER_CMS_URL',
        'SITETILLER_CMS_PUBLISHED_ROOT',
        'SITETILLER_PRODUCTION_DIRECTORY',
      ],
      previous = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
    process.env.SITETILLER_CMS_ROOT = stack.root;
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
    delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
    try {
      const source = await designCmsSource('unpublished'),
        schema = structuredClone(source.context.schema);
      schema.lists.customs = {
        key: 'code',
        label: 'Customs',
        columns: {
          code: { type: 'generated', label: 'Code', readonly: false, valuePattern: 'custom##' },
          serial: { type: 'generated', label: 'Serial', readonly: false, valuePattern: 'serial##' },
          locked: { type: 'generated', label: 'Protected', readonly: true, valuePattern: 'locked##' },
          title: { type: 'text', label: 'Title' },
        },
      };
      const project = new Project(join(stack.root, '.sitetiller/project')),
        slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
        path = 'site/cms/data/customs.json';
      const result = await workflow(
        project,
        slots,
        'Create editable generated fields',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, instruction, input) => {
          assert.match(instruction, /WHOLE digit token/);
          assert.match(input.cms.instruction, /readonly:false/);
          return {
            value: {
              action: 'implement',
              files: [
                { path: 'site/cms/structure.json', content: JSON.stringify(schema) },
                {
                  path,
                  content: JSON.stringify([
                    { code: 'custom99', serial: 'custom201', locked: '', title: 'Non-consuming' },
                    { code: 'custom-001', serial: 'custom1', locked: '', title: 'Consuming' },
                    { code: '', serial: '', locked: '', title: 'Automatic' },
                  ]),
                },
              ],
            },
          };
        },
        undefined,
        [],
        { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
      );
      assert.ok(result.commit);
      const rows = JSON.parse(await readFile(join(stack.root, 'data/customs.json'), 'utf8'));
      assert.deepEqual(
        rows.map((r) => r.code),
        ['custom99', 'custom-001', 'custom02'],
      );
      assert.deepEqual(
        rows.map((r) => r.serial),
        ['custom201', 'custom1', 'serial02'],
      );
      assert.deepEqual(JSON.parse((await project.committedFiles(result.commit))[path]), rows);
      const counterPath = join(stack.root, '.cmstudio-sequences.json'),
        before = await readFile(counterPath, 'utf8'),
        state = JSON.parse(before);
      assert.equal(state.counters.customs.code, '2');
      assert.ok(state.manualValues.customs.code.includes('custom99'));
      assert.ok(
        !Object.keys(await project.committedFiles(result.commit)).some((p) => /sequences|manualValues/.test(p)),
      );
      const fresh = await designCmsSource('unpublished');
      const privateKeys = (value) =>
        value &&
        typeof value === 'object' &&
        Object.entries(value).some(
          ([key, child]) => key === 'manualValues' || key === 'counters' || privateKeys(child),
        );
      assert.ok(!privateKeys(fresh.context));
      const base = await contentBaseline(fresh),
        changed = structuredClone(rows);
      changed[0].serial = 'edited888';
      const files = { ...fresh.files, [path]: JSON.stringify(changed) };
      normalizeContentPlan(files, await applyDesignContent(base, files, true));
      assert.equal(await readFile(counterPath, 'utf8'), before);
      normalizeContentPlan(files, await applyDesignContent(base, files, false));
      assert.equal(JSON.parse(files[path])[0].serial, 'edited888');
      assert.equal(JSON.parse(await readFile(counterPath, 'utf8')).counters.customs.serial, '2');
      assert.equal(JSON.parse((await project.committedFiles(result.commit))[path])[0].serial, 'custom201');
      const latest = await designCmsSource('unpublished'),
        latestBase = await contentBaseline(latest),
        bad = JSON.parse(latest.files[path]);
      bad[0].locked = 'Forbidden';
      const dataBefore = await readFile(join(stack.root, 'data/customs.json'), 'utf8'),
        privateBefore = await readFile(counterPath, 'utf8');
      await assert.rejects(applyDesignContent(latestBase, { ...latest.files, [path]: JSON.stringify(bad) }, false), {
        status: 422,
      });
      assert.equal(await readFile(join(stack.root, 'data/customs.json'), 'utf8'), dataBefore);
      assert.equal(await readFile(counterPath, 'utf8'), privateBefore);
    } finally {
      for (const key of vars) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await stack.close();
    }
  },
);

test(
  'AI-29: AI unique generated keys reject explicit duplicates atomically and skip later reserved manual keys',
  { timeout: 90000 },
  async () => {
    const stack = await isolatedStack(),
      vars = [
        'SITETILLER_CMS_ROOT',
        'SITETILLER_CMS_URL',
        'SITETILLER_CMS_PUBLISHED_ROOT',
        'SITETILLER_PRODUCTION_DIRECTORY',
      ],
      previous = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
    process.env.SITETILLER_CMS_ROOT = stack.root;
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
    delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
    try {
      const source = await designCmsSource('unpublished'),
        base = await contentBaseline(source),
        schema = structuredClone(source.context.schema),
        path = 'site/cms/data/uniqueCodes.json',
        counterPath = join(stack.root, '.cmstudio-sequences.json'),
        counter = async () => {
          try {
            return await readFile(counterPath, 'utf8');
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            return null;
          }
        };
      schema.lists.uniqueCodes = {
        key: 'code',
        label: 'Unique codes',
        columns: {
          code: { type: 'generated', label: 'Unique code', valuePattern: 'code##', readonly: false },
          serial: { type: 'generated', label: 'Serial', valuePattern: 'serial##', readonly: false },
          title: { type: 'text', label: 'Title' },
        },
      };
      const originalSchema = await readFile(join(stack.root, 'schema/structure.json'), 'utf8'),
        beforeCounter = await counter(),
        duplicate = {
          ...source.files,
          'site/cms/structure.json': JSON.stringify(schema),
          [path]: JSON.stringify([
            { code: 'same', serial: '', title: 'First' },
            { code: 'same', serial: '', title: 'Second' },
          ]),
        };
      for (const dry of [true, false]) {
        await assert.rejects(
          applyDesignContent(base, duplicate, dry),
          (error) => error.status === 422 && error.message.includes('Unique code') && error.message.includes('same'),
        );
        assert.equal(await readFile(join(stack.root, 'schema/structure.json'), 'utf8'), originalSchema);
        assert.equal(await counter(), beforeCounter);
        await assert.rejects(readFile(join(stack.root, 'data/uniqueCodes.json')), { code: 'ENOENT' });
        assert.deepEqual(
          JSON.parse(duplicate[path]).map((r) => r.code),
          ['same', 'same'],
        );
      }
      const project = new Project(join(stack.root, '.sitetiller/project')),
        slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
        result = await workflow(
          project,
          slots,
          'Add unique generated codes',
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          async (_c, instruction, input) => {
            assert.match(instruction, /later rows of the same atomic proposal/);
            assert.match(input.cms.instruction, /never silently rewritten/);
            return {
              value: {
                action: 'implement',
                files: [
                  { path: 'site/cms/structure.json', content: JSON.stringify(schema) },
                  {
                    path,
                    content: JSON.stringify([
                      { code: '', serial: '', title: 'Automatic first' },
                      { code: 'code01', serial: 'serial01', title: 'Reserved later' },
                      { code: '', serial: '', title: 'Automatic third' },
                    ]),
                  },
                ],
              },
            };
          },
          undefined,
          [],
          { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
        );
      const rows = JSON.parse(await readFile(join(stack.root, 'data/uniqueCodes.json'), 'utf8'));
      assert.deepEqual(
        rows.map((r) => r.code),
        ['code02', 'code01', 'code03'],
      );
      assert.deepEqual(
        rows.map((r) => r.serial),
        ['serial01', 'serial01', 'serial02'],
      );
      assert.deepEqual(JSON.parse((await project.committedFiles(result.commit))[path]), rows);
      const fresh = await designCmsSource('unpublished'),
        baseline = await contentBaseline(fresh),
        dataBefore = await readFile(join(stack.root, 'data/uniqueCodes.json'), 'utf8'),
        privateBefore = await counter(),
        bad = {
          ...fresh.files,
          [path]: JSON.stringify([...rows, { code: 'code01', serial: '', title: 'Duplicate existing' }]),
        };
      await assert.rejects(
        applyDesignContent(baseline, bad, false),
        (error) => error.status === 422 && error.message.includes('code01') && error.message.includes('Unique code'),
      );
      assert.equal(await readFile(join(stack.root, 'data/uniqueCodes.json'), 'utf8'), dataBefore);
      assert.equal(await counter(), privateBefore);
    } finally {
      for (const key of vars) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await stack.close();
    }
  },
);
