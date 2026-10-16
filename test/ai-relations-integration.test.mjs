import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent } from '../apps/aistudio/src/cms-content-write.ts';
test(
  'AI-29: AI related collections use list target and actual non-code key through normalized save and frozen snapshots',
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
      const source = await designCmsSource('unpublished'),
        schema = structuredClone(source.context.schema);
      schema.lists.releases = {
        key: 'release_key',
        label: 'Releases',
        display: ['name'],
        columns: {
          release_key: { type: 'text', label: 'Release key', required: true },
          name: { type: 'text', label: 'Name' },
        },
      };
      schema.lists.songs = {
        key: 'song_key',
        label: 'Songs',
        display: ['title'],
        columns: {
          song_key: { type: 'text', label: 'Song key', required: true },
          title: { type: 'text', label: 'Title' },
          release: { type: 'list', list: 'releases', label: 'Release', required: true },
        },
      };
      const project = new Project(join(stack.root, '.sitetiller/project')),
        slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
        calls = [];
      global.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const response = await nativeFetch(input, init);
        if (url.pathname === '/api/design-structure' && init?.method === 'POST')
          calls.push({ request: JSON.parse(init.body), response: await response.clone().json() });
        return response;
      };
      const result = await workflow(
        project,
        slots,
        'Create releases and their songs',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, instruction, input) => {
          assert.match(instruction, /Odkaz na kolekci/);
          assert.match(input.cms.instruction, /not a text field/);
          assert.equal(input.capabilities.contentStructure.relationships.type, 'list');
          assert.equal(input.capabilities.contentStructure.relationships.targetProperty, 'list');
          return {
            value: {
              action: 'implement',
              files: [
                { path: 'site/cms/structure.json', content: JSON.stringify(schema) },
                {
                  path: 'site/cms/data/releases.json',
                  content: JSON.stringify([{ release_key: 'release-one', name: 'Display name differs from key' }]),
                },
                {
                  path: 'site/cms/data/songs.json',
                  content: JSON.stringify([{ song_key: 'song-one', title: 'Song', release: 'release-one' }]),
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
      assert.deepEqual(
        calls.map((c) => c.request.dryRun),
        [true, false],
      );
      const preview = calls[0].response,
        actual = calls[1].response;
      assert.equal(preview.schema.lists.songs.columns.release.type, 'list');
      assert.equal(preview.schema.lists.songs.columns.release.list, 'releases');
      assert.equal(preview.schema.lists.releases.key, 'release_key');
      assert.equal(preview.collections.songs[0].release, 'release-one');
      assert.deepEqual(preview.collections.songs, actual.lists.songs.rows);
      const frozen = await project.committedFiles(result.commit),
        savedSchema = JSON.parse(await readFile(join(stack.root, 'schema/structure.json'), 'utf8'));
      assert.deepEqual(JSON.parse(frozen['site/cms/structure.json']), savedSchema);
      for (const name of ['releases', 'songs'])
        assert.deepEqual(
          JSON.parse(frozen['site/cms/data/' + name + '.json']),
          JSON.parse(await readFile(join(stack.root, 'data/' + name + '.json'), 'utf8')),
        );
      const fresh = await designCmsSource('unpublished'),
        base = await contentBaseline(fresh),
        beforeSongs = await readFile(join(stack.root, 'data/songs.json'), 'utf8');
      await assert.rejects(
        applyDesignContent(
          base,
          {
            ...fresh.files,
            'site/cms/data/songs.json': JSON.stringify([
              { song_key: 'song-one', title: 'Song', release: 'Display name differs from key' },
            ]),
          },
          false,
        ),
        { status: 422 },
      );
      assert.equal(await readFile(join(stack.root, 'data/songs.json'), 'utf8'), beforeSongs);
      await assert.rejects(applyDesignContent(base, { ...fresh.files, 'site/cms/data/releases.json': '[]' }, false), {
        status: 422,
      });
      const follow = {
        ...fresh.files,
        'site/cms/data/songs.json': JSON.stringify([
          { song_key: 'song-one', title: 'Updated', release: 'release-one' },
        ]),
      };
      await applyDesignContent(base, follow, true);
      await applyDesignContent(base, follow, false);
      assert.equal(JSON.parse(frozen['site/cms/data/songs.json'])[0].title, 'Song');
      const count = calls.length,
        head = await project.head();
      const denied = await workflow(
        project,
        slots,
        'Edit published relation',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async () => ({
          value: { action: 'implement', files: [{ path: 'site/cms/structure.json', content: JSON.stringify(schema) }] },
        }),
        undefined,
        [],
        { cmsSource: 'published', requestChecks: { technical: false, verification: false } },
      );
      assert.equal(denied.conversationOnly, true);
      assert.equal(await project.head(), head);
      assert.equal(calls.length, count);
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
