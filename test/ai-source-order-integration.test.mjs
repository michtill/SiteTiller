import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent } from '../apps/aistudio/src/cms-content-write.ts';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
import { recentConversation } from '../apps/aistudio/src/memory.ts';
import {
  source,
  tracksDefinition,
  listProposal,
  prefixProposal,
  request,
  titles,
  albumCode,
  sourceUrl,
} from '../apps/aistudio/test/fixtures/source-order.ts';
// A retry ("znovu") after a failed explicit request, and the explicit request itself.
const traces = [
    { id: 'retry', prompt: 'znovu', sources: [source()], tracksDefinition, proposals: [prefixProposal()] },
    { id: 'explicit', prompt: request, sources: [source()], tracksDefinition, proposals: [listProposal()] },
  ],
  slots = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }];
async function fixture(run) {
  const stack = await isolatedStack(),
    vars = [
      'SITETILLER_CMS_ROOT',
      'SITETILLER_CMS_URL',
      'SITETILLER_CMS_PUBLISHED_ROOT',
      'SITETILLER_PRODUCTION_DIRECTORY',
    ],
    old = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  process.env.SITETILLER_CMS_ROOT = stack.root;
  process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
  delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
  process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
  try {
    const source = await designCmsSource('unpublished'),
      schema = structuredClone(source.context.schema);
    schema.lists.albums = {
      key: 'code',
      label: 'Albums',
      columns: { code: { type: 'text', label: 'Key' }, title: { type: 'text', label: 'Title' } },
    };
    schema.lists.tracks = traces[1].tracksDefinition;
    await applyDesignContent(
      await contentBaseline(source),
      {
        ...source.files,
        'site/cms/structure.json': JSON.stringify(schema),
        'site/cms/data/albums.json': JSON.stringify([{ code: albumCode, title: 'Demo album' }]),
        'site/cms/data/tracks.json': '[]',
      },
      false,
    );
    return await run(stack, new Project(join(stack.root, '.sitetiller/project')));
  } finally {
    for (const k of vars) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    await stack.close();
  }
}
const evidence = (t) => ({
    ...t.sources[0],
    citationText: t.sources[0].text + '\n' + JSON.stringify(t.sources[0].structuredData),
  }),
  options = (t) => ({
    cmsSource: 'unpublished',
    requestChecks: { technical: false, verification: false },
    webSource: async () => evidence(t),
    webImport: async () => {
      throw Error('Unexpected website import');
    },
  });
test(
  'AI-32: a retry and an explicit request store verified ordinals and immutable snapshots with no presentation mutation',
  { timeout: 90000 },
  () =>
    fixture(async (stack, project) => {
      for (const trace of traces) {
        const reset = await designCmsSource('unpublished');
        await applyDesignContent(
          await contentBaseline(reset),
          { ...reset.files, 'site/cms/data/tracks.json': '[]' },
          false,
        );
        const activeProject = new Project(join(stack.root, '.sitetiller', 'trace-' + trace.id));
        await activeProject.init(null);
        let calls = 0;
        const before = await activeProject.files(),
          pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8');
        const result = await workflow(
          activeProject,
          slots,
          trace.prompt,
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          async (_c, _i, input) => {
            calls++;
            assert.equal(input.webIntent.contentOnly, true);
            if (calls === 1)
              return { value: { action: 'web', purpose: 'source', url: trace.sources[0].url, scope: 'edit' } };
            return { value: structuredClone(trace.proposals.at(-1)) };
          },
          undefined,
          [],
          {
            ...options(trace),
            conversation: {
              turns: [
                { active: true, status: 'failed', request: traces[1].prompt },
                { active: true, status: 'failed', request: sourceUrl },
              ],
            },
          },
        );
        assert.equal(calls, 2);
        assert.ok(result.commit);
        const actual = JSON.parse(await readFile(join(stack.root, 'data/tracks.json'), 'utf8'));
        assert.deepEqual(
          actual.map((row) => row.position),
          Array.from({ length: titles.length }, (_, i) => String(i + 1)),
        );
        assert.ok(actual.every((row) => row.album_code === albumCode));
        assert.deepEqual(
          JSON.parse((await activeProject.committedFiles(result.commit))['site/cms/data/tracks.json']),
          actual,
        );
        const after = await activeProject.files();
        for (const [path, text] of Object.entries(before))
          if (!path.startsWith('site/cms/')) assert.equal(after[path], text);
        assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
        if (trace === traces[0]) assert.match(result.plan.summary, /orderInferredNotLiteral/); // the final answer is composed from this fact
      }
    }),
);
test(
  'AI-32: optional unverified order completes with blank values; human-authored numbers remain intact',
  { timeout: 90000 },
  () =>
    fixture(async (stack, project) => {
      const trace = traces[1],
        source = evidence(trace);
      source.structuredData = [];
      source.citationText = source.text;
      let calls = 0;
      const result = await workflow(
        project,
        slots,
        trace.prompt,
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async () => {
          if (++calls === 1) return { value: { action: 'web', url: source.url, purpose: 'source', scope: 'edit' } };
          return { value: structuredClone(trace.proposals.at(-1)) };
        },
        undefined,
        [],
        { ...options(trace), webSource: async () => source },
      );
      assert.ok(result.commit);
      assert.equal(result.conversationOnly, undefined);
      const rows = JSON.parse(await readFile(join(stack.root, 'data/tracks.json'), 'utf8'));
      assert.equal(rows.length, titles.length);
      assert.ok(rows.every((row) => row.position === ''));
      assert.match(result.plan.summary, /optionalOrderLeftBlank/); // the final answer is composed from this fact
      const proposal = structuredClone(trace.proposals.at(-1)),
        custom = JSON.parse(proposal.files[0].content);
      custom[0].position = '99';
      proposal.files[0].content = JSON.stringify(custom);
      proposal.sourceFacts.push({
        basis: 'user',
        collection: 'tracks',
        field: 'position',
        value: '99',
        quote: titles[0] + ' pořadí 99',
      });
      calls = 0;
      const authored = await workflow(
        project,
        slots,
        trace.prompt + '; ' + titles[0] + ' pořadí 99',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async () => ({
          value:
            ++calls === 1
              ? { action: 'web', url: source.url, purpose: 'source', scope: 'edit' }
              : structuredClone(proposal),
        }),
        undefined,
        [],
        options(trace),
      );
      assert.ok(authored.commit);
      assert.equal(JSON.parse(await readFile(join(stack.root, 'data/tracks.json'), 'utf8'))[0].position, '99');
    }),
);
test(
  'AI-32: uncertain proposal is an answer with unchanged content; affirmative user followup honors the offered value',
  { timeout: 90000 },
  () =>
    fixture(async (stack, project) => {
      const trace = traces[1],
        proposal = structuredClone(trace.proposals.at(-1)),
        rows = JSON.parse(proposal.files[0].content);
      rows[0].title = 'User-confirmed custom track';
      proposal.files[0].content = JSON.stringify(rows);
      const originalHead = await project.head(),
        originalData = await readFile(join(stack.root, 'data/tracks.json'), 'utf8');
      let calls = 0;
      const decision = await workflow(
        project,
        slots,
        trace.prompt,
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async () => ({
          value:
            ++calls === 1
              ? { action: 'web', url: trace.sources[0].url, purpose: 'source', scope: 'edit' }
              : structuredClone(proposal),
        }),
        undefined,
        [],
        options(trace),
      );
      assert.equal(decision.conversationOnly, true);
      assert.match(decision.plan.summary, /Chcete/);
      assert.equal(await project.head(), originalHead);
      assert.equal(await readFile(join(stack.root, 'data/tracks.json'), 'utf8'), originalData);
      const conversation = recentConversation(
        [
          {
            id: 'offered',
            status: 'answered',
            prompt: trace.prompt,
            resolvedRequest: decision.resolvedRequest,
            memory: decision.memory,
          },
        ],
        originalHead,
      );
      assert.ok(conversation.turns[0].sourceDecisions.some((value) => value.value === 'User-confirmed custom track'));
      calls = 0;
      const result = await workflow(
        project,
        slots,
        'ano, použij navržené hodnoty',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, _i, input) => {
          assert.equal(input.webIntent.contentOnly, true);
          return {
            value:
              ++calls === 1
                ? { action: 'web', url: trace.sources[0].url, purpose: 'source', scope: 'edit' }
                : structuredClone(proposal),
          };
        },
        undefined,
        [],
        { ...options(trace), conversation },
      );
      assert.ok(result.commit);
      assert.equal(result.conversationOnly, undefined);
      const actual = JSON.parse(await readFile(join(stack.root, 'data/tracks.json'), 'utf8'));
      assert.equal(actual[0].title, 'User-confirmed custom track');
      assert.equal(actual[0].position, '');
      assert.deepEqual(JSON.parse((await project.committedFiles(result.commit))['site/cms/data/tracks.json']), actual);
    }),
);
