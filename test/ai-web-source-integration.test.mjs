import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent } from '../apps/aistudio/src/cms-content-write.ts';
import { readPublicSource } from '../apps/aistudio/src/web-source.ts';
const brief =
    'Najdi seznam skladeb alba NOČNÍ VLAK na internetu. Seznam přidej do skladeb v obsahu pod album NOČNÍ VLAK, které už tam je.',
  url = 'https://open.spotify.com/album/fixture',
  slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }];
async function setup(run) {
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
    schema.lists.sourceAlbums = {
      key: 'albumKey',
      label: 'Albums',
      columns: { albumKey: { type: 'text', label: 'Key' }, title: { type: 'text', label: 'Title' } },
    };
    schema.lists.sourceTracks = {
      key: 'trackKey',
      label: 'Tracks',
      columns: {
        trackKey: { type: 'generated', label: 'Key', readonly: true, valuePattern: 'track-###' },
        title: { type: 'text', label: 'Title' },
        album: { type: 'list', list: 'sourceAlbums', label: 'Album' },
        position: { type: 'number', label: 'Position' },
      },
    };
    await applyDesignContent(
      await contentBaseline(source),
      {
        ...source.files,
        'site/cms/structure.json': JSON.stringify(schema),
        'site/cms/data/sourceAlbums.json': '[{"albumKey":"existing-album","title":"NOČNÍ VLAK"}]',
        'site/cms/data/sourceTracks.json': '[]',
      },
      false,
    );
    return await run(stack, new Project(join(stack.root, '.sitetiller/project')));
  } finally {
    for (const k of vars) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    await stack.close();
  }
}
test(
  'AI-31: answered/failed content brief plus bare URL reads actual evidence, preserves edit scope/presentation and freezes saved references',
  { timeout: 90000 },
  () =>
    setup(async (stack, project) => {
      for (const status of ['answered', 'failed']) {
        const before = await project.files(),
          pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8'),
          source = await designCmsSource('unpublished'),
          path = 'site/cms/data/sourceTracks.json',
          existing = JSON.parse(source.files[path]),
          name = 'Verified track ' + status,
          position = String(existing.length + 1);
        let calls = 0,
          reads = 0;
        const events = [];
        const result = await workflow(
          project,
          slots,
          url,
          join(stack.root, '.sitetiller/drafts'),
          (event) => events.push(event),
          async (_c, _i, input) => {
            calls++;
            assert.equal(input.scope, 'edit');
            assert.ok(input.resolvedRequest.includes(brief));
            if (calls === 1) return { value: { action: 'web', scope: 'edit', purpose: 'source', url } };
            assert.equal(input.webImport, undefined);
            assert.equal(input.files['site/index.html'], before['site/index.html']);
            assert.equal(input.sources.length, 1);
            const id = input.sources[0].id;
            return {
              value: {
                action: 'implement',
                scope: 'edit',
                files: [
                  {
                    path,
                    content: JSON.stringify([
                      ...existing,
                      { trackKey: '', title: name, album: 'existing-album', position },
                    ]),
                  },
                ],
                sourceFacts: [
                  { sourceId: id, collection: 'sourceTracks', field: 'title', value: name, quote: name },
                  {
                    sourceId: id,
                    collection: 'sourceTracks',
                    field: 'position',
                    value: position,
                    quote: '"position":' + position,
                  },
                ],
              },
            };
          },
          undefined,
          [],
          {
            cmsSource: 'unpublished',
            requestChecks: { technical: false, verification: false },
            conversation: {
              turns: [
                { active: true, status, request: brief, summary: 'Please provide album URL' },
                { active: true, status: 'failed', request: url },
              ],
            },
            webImport: async () => {
              throw Error('Must not import Spotify presentation');
            },
            webSource: async (requested) => {
              reads++;
              return readPublicSource(requested, async () => ({
                url: requested,
                mime: 'application/ld+json',
                bytes: Buffer.from(JSON.stringify({ album: 'NOČNÍ VLAK', track: [{ name, position: Number(position) }] })),
              }));
            },
          },
        );
        assert.equal(reads, 1);
        assert.equal(calls, 2);
        assert.equal(result.scope, 'edit');
        assert.ok(result.commit);
        const after = await project.files();
        for (const [file, text] of Object.entries(before))
          if (!file.startsWith('site/cms/')) assert.equal(after[file], text);
        assert.ok(!events.some((event) => event.message === 'Načítám veřejný web do návrhu.'));
        const actual = JSON.parse(await readFile(join(stack.root, 'data/sourceTracks.json'), 'utf8'));
        assert.equal(actual.at(-1).title, name);
        assert.equal(actual.at(-1).album, 'existing-album');
        assert.equal(actual.at(-1).position, position);
        assert.match(actual.at(-1).trackKey, /^track-\d+$/);
        assert.deepEqual(JSON.parse((await project.committedFiles(result.commit))[path]), actual);
        assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
      }
    }),
);
test(
  'AI-31: source-only failure/empty evidence, scope repairs and presentation denial never write content or draft',
  { timeout: 90000 },
  () =>
    setup(async (stack, project) => {
      const before = await project.head(),
        rows = await readFile(join(stack.root, 'data/sourceTracks.json'), 'utf8'),
        counter = async () => {
          try {
            return await readFile(join(stack.root, '.cmstudio-sequences.json'), 'utf8');
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            return null;
          }
        },
        privateBefore = await counter(),
        options = {
          cmsSource: 'unpublished',
          requestChecks: { technical: false, verification: false },
          conversation: { turns: [{ active: true, status: 'answered', request: brief }] },
        };
      for (const empty of [false, true]) {
        let calls = 0;
        const result = await workflow(
          project,
          slots,
          url,
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          async () => {
            calls++;
            return { value: { action: 'web', url, scope: 'edit' } };
          },
          undefined,
          [],
          {
            ...options,
            webSource: async () => {
              if (!empty) throw Error('Source unavailable');
              return readPublicSource(url, async () => ({
                url,
                mime: 'text/html',
                bytes: Buffer.from('<script>dynamic-only shell</script>'),
              }));
            },
          },
        );
        assert.equal(result.conversationOnly, true);
        assert.equal(calls, 1);
        assert.match(result.plan.summary, /čitelný seznam/);
        assert.equal(await project.head(), before);
        assert.equal(await readFile(join(stack.root, 'data/sourceTracks.json'), 'utf8'), rows);
        assert.equal(await counter(), privateBefore);
      }
      let calls = 0;
      const result = await workflow(
        project,
        slots,
        url,
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, _i, input) => {
          calls++;
          if (calls === 1) return { value: { action: 'web', url, scope: 'create' } };
          if (calls === 2) {
            assert.match(input.feedback.requiredFixes[0], /scope/);
            assert.equal(input.scope, 'edit');
            return { value: { action: 'web', url, scope: 'edit' } };
          }
          return {
            value: { action: 'answer', summary: 'Zdroj obsahuje pouze název alba, ne seznam skladeb. Pošlete seznam.' },
          };
        },
        undefined,
        [],
        {
          ...options,
          webSource: async () =>
            readPublicSource(url, async () => ({ url, mime: 'text/plain', bytes: Buffer.from('NOČNÍ VLAK') })),
        },
      );
      assert.equal(result.scope, 'edit');
      assert.equal(result.conversationOnly, true);
      assert.equal(calls, 3);
      let step = 0;
      await assert.rejects(
        workflow(
          project,
          slots,
          url,
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          async () => {
            if (++step === 1) return { value: { action: 'web', url, scope: 'edit' } };
            return {
              value: { action: 'implement', files: [{ path: 'site/index.html', content: 'Replace with Spotify' }] },
            };
          },
          undefined,
          [],
          {
            ...options,
            webSource: async () =>
              readPublicSource(url, async () => ({ url, mime: 'text/plain', bytes: Buffer.from('NOČNÍ VLAK') })),
          },
        ),
        /prezentaci/,
      );
      assert.equal(await project.head(), before);
      assert.equal(await readFile(join(stack.root, 'data/sourceTracks.json'), 'utf8'), rows);
      assert.equal(await counter(), privateBefore);
      let fetched = false;
      const denied = await workflow(
        project,
        slots,
        url,
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async () => ({ value: { action: 'web', url, requiresContentWrite: true } }),
        undefined,
        [],
        {
          ...options,
          cmsSource: 'published',
          webSource: async () => {
            fetched = true;
            throw Error('Forbidden');
          },
        },
      );
      assert.equal(denied.conversationOnly, true);
      assert.equal(fetched, false);
    }),
);
