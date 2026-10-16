import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isolatedStack } from './support/stack.mjs';
import { readJson } from '../packages/settings/index.mjs';
import { workingContentRevision } from '../packages/content/working-revision.mjs';
import { designCmsSource } from '../apps/aistudio/src/cms-design-source.ts';
import { contentBaseline, applyDesignContent, normalizeContentPlan } from '../apps/aistudio/src/cms-content-write.ts';
import { assertCmsChanges, refreshCmsCandidate } from '../apps/aistudio/src/cms-source.ts';
import { workflow } from '../apps/aistudio/test/fixtures/workflow.ts';
import { Project } from '../apps/aistudio/src/project.ts';
import { browserChecks } from '../apps/aistudio/src/checks.ts';
import { renderCmsPage } from '../apps/aistudio/src/cms-render.ts';
const realFetch = globalThis.fetch;
// Live editing lives in the running Content Editor (switched by /api/edit-mode, ended by AI writes).
async function enableLiveEditing(stack) {
  const cm = 'http://127.0.0.1:' + stack.ports.cmstudio,
    { token } = await (await realFetch(cm + '/api/bootstrap')).json(),
    reply = await realFetch(cm + '/api/edit-mode', {
      method: 'POST',
      headers: { Origin: cm, 'x-cms-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoPublish: true }),
    });
  assert.equal(reply.status, 200);
}
async function liveEditing(stack) {
  return (await (await realFetch('http://127.0.0.1:' + stack.ports.cmstudio + '/api/edit-mode')).json()).autoPublish;
}
const vars = [
  'SITETILLER_CMS_ROOT',
  'SITETILLER_CMS_URL',
  'SITETILLER_CMS_PUBLISHED_ROOT',
  'SITETILLER_PRODUCTION_DIRECTORY',
];
async function setup(stack) {
  const previous = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  process.env.SITETILLER_CMS_ROOT = stack.root;
  process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + stack.ports.cmstudio;
  delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
  process.env.SITETILLER_PRODUCTION_DIRECTORY = join(stack.root, '.production');
  return () => {
    for (const key of vars) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}
const slots = [{ provider: 'openai', key: 'fixture-no-network', highModel: 'fixture', lowModel: 'fixture' }];
test(
  'AI-05: agents stage schema/new collections/folders, preview normalized migrated rows before real atomic CM write, freeze history',
  { timeout: 90000 },
  async () => {
    const stack = await isolatedStack(),
      restore = await setup(stack),
      nativeFetch = global.fetch;
    try {
      await enableLiveEditing(stack);
      const beforeSource = await designCmsSource('unpublished'),
        name = Object.keys(beforeSource.context.schema.lists)[0],
        definition = beforeSource.context.schema.lists[name],
        first = JSON.parse(beforeSource.files['site/cms/data/' + name + '.json'])[0],
        recordKey = first[definition.key],
        revision = await workingContentRevision(stack.root),
        pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8'),
        publishedSchema = beforeSource.context.sources.published.schema,
        proposal = structuredClone(beforeSource.context.schema),
        expected = 'New field from the validated candidate';
      proposal.lists[name].columns.summaryLine = {
        type: 'text',
        label: 'Summary line',
        required: true,
        default: expected,
      };
      proposal.lists[name].columns.writerRef = {
        type: 'list',
        label: 'Writer',
        list: 'contributors',
        required: true,
      };
      proposal.lists[name].columns.downloadRef = { type: 'file', label: 'Document', folder: 'handouts' };
      proposal.lists.contributors = {
        key: 'id',
        label: 'Contributors',
        display: ['label'],
        columns: {
          id: { type: 'text', label: 'Identifier', required: true },
          label: { type: 'text', label: 'Label', required: true },
        },
      };
      proposal.folders.handouts = { label: 'Handouts', type: 'other' };
      const calls = [];
      global.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url || input);
        if (init?.method === 'POST' && url.port === String(stack.ports.cmstudio)) {
          assert.ok(
            !['/api/publication', '/api/discard-changes'].includes(url.pathname),
            'No publication during design',
          );
          if (url.pathname.startsWith('/api/design-')) calls.push({ path: url.pathname, body: JSON.parse(init.body) });
        }
        return nativeFetch(input, init);
      };
      const project = new Project(join(stack.root, '.sitetiller/project'));
      let modelRounds = 0,
        checked = false,
        verified = false;
      const model = async (_client, _instruction, input) => {
        if (input.testResults) {
          assert.equal(await workingContentRevision(stack.root), revision);
          assert.equal(input.cms.schema.version, publishedSchema.version + 1);
          assert.ok(input.diff.some((f) => f.path === 'site/cms/structure.json'));
          assert.ok(
            input.cms.media.some((item) => item.source === 'handouts/guide.txt' && item.available && item.staged),
          );
          verified = true;
          return { value: { status: 'PASS', requiredFixes: [] } };
        }
        assert.equal(input.cms.permissions.schema, 'write');
        if (++modelRounds === 1)
          return {
            value: {
              action: 'stage',
              summary: 'Stage proposed content structure',
              files: [],
              textEdits: [
                {
                  kind: 'replace',
                  path: 'site/cms/structure.json',
                  before: input.files['site/cms/structure.json'],
                  after: JSON.stringify(proposal),
                },
              ],
            },
          };
        assert.ok(input.cms.schema.lists.contributors);
        assert.ok(input.cms.schema.folders.handouts);
        assert.equal(input.files['site/cms/data/contributors.json'], '[]');
        assert.ok(input.cms.schema.lists[name].columns.summaryLine);
        assert.deepEqual(input.cms.sources.published.schema, publishedSchema);
        const rows = JSON.parse(input.files['site/cms/data/' + name + '.json']).map((row) => ({
            ...row,
            // A link has no default value: the agent fills it in the rows.
            writerRef: 'person-one',
            downloadRef: 'handouts/guide.txt',
          })),
          manifest = JSON.parse(input.files['site/rendering.json']);
        manifest.pages['site/structure-proof.html'] = 'site/templates/structure-proof.txt';
        const template =
          '<!doctype html><html><head><title>Structure candidate</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Candidate</h1><p id="new-field">{{value "' +
          name +
          '" "' +
          recordKey +
          '" "summaryLine"}}</p><a id="download" href="{{asset (value "' +
          name +
          '" "' +
          recordKey +
          '" "downloadRef")}}">Document</a></main></body></html>';
        return {
          value: {
            action: 'implement',
            summary: 'Validated structure and document',
            needsVerification: true,
            textEdits: [
              {
                kind: 'replace',
                path: 'site/cms/data/' + name + '.json',
                before: input.files['site/cms/data/' + name + '.json'],
                after: JSON.stringify(rows),
              },
              {
                kind: 'replace',
                path: 'site/cms/data/contributors.json',
                before: input.files['site/cms/data/contributors.json'],
                after: JSON.stringify([{ id: 'person-one', label: 'Fixture contributor' }]),
              },
            ],
            files: [
              { path: 'site/assets/guide.txt', content: 'Fixture guide bytes' },
              { path: 'site/rendering.json', content: JSON.stringify(manifest) },
              { path: 'site/templates/structure-proof.txt', content: template },
              {
                path: 'site/structure-proof.html',
                content:
                  '<!doctype html><html><head><title>Candidate</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>Fallback</body></html>',
              },
            ],
            contentFiles: [{ source: 'site/assets/guide.txt', folder: 'handouts', name: 'guide.txt' }],
            browserTests: [
              {
                name: 'new field rendered before working commit',
                path: 'site/structure-proof.html',
                steps: [
                  { action: 'expectText', selector: '#new-field', equals: expected },
                  {
                    action: 'expectAttribute',
                    selector: '#download',
                    attribute: 'href',
                    contains: 'cms/files/handouts/guide.txt',
                  },
                ],
              },
            ],
          },
        };
      };
      const result = await workflow(
        project,
        slots,
        'Přidej strukturu a dokument s požadovanou výchozí hodnotou',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        model,
        undefined,
        [],
        {
          cmsSource: 'unpublished',
          check: async (path, files, scenarios, images) => {
            assert.equal(await workingContentRevision(stack.root), revision);
            assert.equal(
              (await readJson(join(stack.root, 'schema/structure.json'))).lists[name].columns.summaryLine,
              undefined,
            );
            assert.equal(await liveEditing(stack), true);
            await assert.rejects(stat(join(stack.root, 'media/handouts/guide.txt')), { code: 'ENOENT' });
            assert.match(await renderCmsPage('site/structure-proof.html', files), new RegExp(expected));
            const evidence = await browserChecks(path, files, scenarios, images);
            assert.equal(evidence.passed, true, JSON.stringify(evidence.errors));
            checked = true;
            return evidence;
          },
        },
      );
      assert.ok(checked && verified);
      assert.equal(modelRounds, 2);
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((c) => [c.path, c.body.dryRun]),
        [
          ['/api/design-structure', true],
          ['/api/design-structure', false],
        ],
      );
      assert.equal(calls[0].body.expectedRevision, revision);
      assert.equal(calls[1].body.expectedRevision, revision);
      assert.equal(
        calls[0].body.changes.find((c) => c.collection === 'contributors').revision,
        createHash('sha256').update('[]\n').digest('hex'),
      );
      const after = await designCmsSource('unpublished'),
        base = await contentBaseline(after),
        bootstrap = await (await nativeFetch(process.env.SITETILLER_CMS_URL + '/api/bootstrap')).json();
      assert.equal(base.contentRevision, bootstrap.contentRevision);
      assert.equal(after.context.schema.version, proposal.version + 1);
      assert.equal(await liveEditing(stack), false);
      assert.equal(await readFile(join(stack.root, 'media/handouts/guide.txt'), 'utf8'), 'Fixture guide bytes');
      const frozen = await project.committedFiles(result.commit);
      assert.deepEqual(JSON.parse(frozen['site/cms/structure.json']), after.context.schema);
      assert.equal(JSON.parse(frozen['site/cms/data/' + name + '.json'])[0].summaryLine, expected);
      assert.equal(JSON.parse(frozen['site/cms/data/' + name + '.json'])[0].writerRef, 'person-one');
      assert.equal(
        (await project.binary(result.commit, 'site/cms/files/handouts/guide.txt')).toString(),
        'Fixture guide bytes',
      );
      assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
      const next = {
        ...after.files,
        'site/cms/data/contributors.json': JSON.stringify([
          { id: 'person-one', label: 'Fixture contributor' },
          { id: 'person-two', label: 'Later fixture' },
        ]),
      };
      await applyDesignContent(base, next, true);
      await applyDesignContent(base, next, false);
      assert.equal(calls.at(-1).path, '/api/design-content');
      assert.equal(
        JSON.parse((await project.committedFiles(result.commit))['site/cms/data/contributors.json']).length,
        1,
      );
      const historical = await nativeFetch(
        'http://127.0.0.1:' + stack.ports.preview + '/versions/' + result.commit + '/structure-proof.html',
      );
      assert.equal(historical.status, 200);
      assert.match(await historical.text(), new RegExp(expected));
      assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
      const count = calls.length,
        head = await project.head();
      const blocked = await workflow(
        project,
        slots,
        'Změň strukturu publikovaného obsahu',
        join(stack.root, '.sitetiller/drafts'),
        () => {},
        async (_c, _i, input) => {
          assert.equal(input.cms.permissions.schema, 'read');
          return {
            value: {
              action: 'implement',
              files: [],
              textEdits: [
                {
                  kind: 'replace',
                  path: 'site/cms/structure.json',
                  before: input.files['site/cms/structure.json'],
                  after: JSON.stringify(proposal),
                },
              ],
            },
          };
        },
        undefined,
        [],
        { cmsSource: 'published' },
      );
      assert.equal(blocked.conversationOnly, true);
      assert.match(blocked.plan.summary, /Nepublikovaný/);
      assert.equal(await project.head(), head);
      assert.equal(calls.length, count);
    } finally {
      global.fetch = nativeFetch;
      restore();
      await stack.close();
    }
  },
);
test(
  'AI-05: structure/global/row CAS and destructive guards have no partial writes; historical source cannot gain working schema permission',
  { timeout: 60000 },
  async () => {
    const stack = await isolatedStack(),
      restore = await setup(stack);
    try {
      await enableLiveEditing(stack);
      let source = await designCmsSource('unpublished'),
        base = await contentBaseline(source);
      const name = Object.keys(source.context.schema.lists)[0],
        proposal = structuredClone(source.context.schema);
      proposal.lists[name].columns.lateField = { type: 'text', label: 'Late field' };
      proposal.folders.newFolder = { type: 'other', label: 'New folder' };
      const candidate = { ...source.files, 'site/cms/structure.json': JSON.stringify(proposal) };
      const ownerRows = JSON.parse(source.files['site/cms/data/' + name + '.json']);
      ownerRows[0].title = 'Concurrent owner change';
      await writeFile(join(stack.root, 'data', name + '.json'), JSON.stringify(ownerRows));
      const ownerRevision = await workingContentRevision(stack.root);
      await assert.rejects(
        applyDesignContent(base, candidate, false, [
          { folder: 'newFolder', name: 'new.txt', data: Buffer.from('new').toString('base64') },
        ]),
        { status: 409 },
      );
      assert.equal(await workingContentRevision(stack.root), ownerRevision);
      assert.equal(await liveEditing(stack), true);
      await assert.rejects(stat(join(stack.root, 'media/newFolder')), { code: 'ENOENT' });
      source = await designCmsSource('unpublished');
      base = await contentBaseline(source);
      const files = {
        ...source.files,
        'site/cms/structure.json': JSON.stringify(proposal),
        ['site/cms/data/' + name + '.json']: JSON.stringify(ownerRows.map((r) => ({ ...r, title: 'Proposed change' }))),
      };
      await assert.rejects(
        applyDesignContent({ ...base, revisions: { ...base.revisions, [name]: '0'.repeat(64) } }, files, false),
        { status: 409 },
      );
      await assert.rejects(applyDesignContent({ ...base, schemaRevision: '0'.repeat(64) }, files, false), {
        status: 409,
      });
      assert.equal(await workingContentRevision(stack.root), ownerRevision);
      const populated = Object.keys(proposal.lists[name].columns).find(
          (key) => key !== proposal.lists[name].key && ownerRows.some((row) => row[key]),
        ),
        destructive = structuredClone(proposal);
      delete destructive.lists[name].columns[populated];
      for (const key of ['display', 'group']) {
        const values = destructive.lists[name][key];
        if (Array.isArray(values)) destructive.lists[name][key] = values.filter((v) => v !== populated);
        else if (values === populated) destructive.lists[name][key] = [];
      }
      const erased = ownerRows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== populated)),
      );
      await assert.rejects(
        applyDesignContent(
          base,
          {
            ...source.files,
            'site/cms/structure.json': JSON.stringify(destructive),
            ['site/cms/data/' + name + '.json']: JSON.stringify(erased),
          },
          false,
        ),
        { status: 422 },
      );
      assert.equal(await workingContentRevision(stack.root), ownerRevision);
      assert.equal(await liveEditing(stack), true);
      const published = await designCmsSource('published');
      assert.throws(() =>
        assertCmsChanges(
          { files: [{ path: 'site/cms/structure.json', content: JSON.stringify(proposal) }] },
          published.context,
        ),
      );
      const forged = { ...source, historySource: published.historySource };
      const frozenBase = await contentBaseline(forged);
      assert.equal(frozenBase.schemaWritable, false);
      await assert.rejects(applyDesignContent(frozenBase, candidate, false), /pouze pro čtení/);
      const versionOnly = {
        ...source.files,
        'site/cms/structure.json': JSON.stringify({ ...source.context.schema, version: 100 }),
        ['site/cms/data/' + name + '.json']: JSON.stringify(
          ownerRows.map((row) => ({ ...row, title: 'Valid row dry-run' })),
        ),
      };
      const rowsOnly = await applyDesignContent(base, versionOnly, true);
      normalizeContentPlan(versionOnly, rowsOnly);
      assert.equal(JSON.parse(versionOnly['site/cms/structure.json']).version, source.context.schema.version);
      assert.equal(await workingContentRevision(stack.root), ownerRevision);
      const ordering = structuredClone(source.context.schema);
      ordering.lists[name].columns = Object.fromEntries(Object.entries(ordering.lists[name].columns).reverse());
      const orderPlan = await applyDesignContent(
        base,
        { ...source.files, 'site/cms/structure.json': JSON.stringify(ordering) },
        true,
      );
      assert.equal(orderPlan.validated, true);
      assert.deepEqual(Object.keys(orderPlan.schema.lists[name].columns), Object.keys(ordering.lists[name].columns));
      assert.equal(await workingContentRevision(stack.root), ownerRevision);
    } finally {
      restore();
      await stack.close();
    }
  },
);
test(
  'AI-05: actual schema batch conflicts after successful candidate checks: owner edit survives and draft HEAD rolls back',
  { timeout: 60000 },
  async () => {
    const stack = await isolatedStack(),
      restore = await setup(stack);
    try {
      await enableLiveEditing(stack);
      const source = await designCmsSource('unpublished'),
        name = Object.keys(source.context.schema.lists)[0],
        schema = structuredClone(source.context.schema),
        schemaBytes = await readFile(join(stack.root, 'schema/structure.json')),
        pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8'),
        project = new Project(join(stack.root, '.sitetiller/project')),
        head = await project.head();
      schema.lists[name].columns.pendingField = { type: 'text', label: 'Pending field', default: 'Valid default' };
      schema.lists.newRecords = {
        label: 'New records',
        key: 'id',
        columns: { id: { type: 'text', label: 'Identifier', required: true }, label: { type: 'text', label: 'Label' } },
      };
      let ownerText,
        checked = false;
      const model = async (_c, _instruction, input) => {
        if (input.testResults) {
          const rows = JSON.parse(await readFile(join(stack.root, 'data', name + '.json'), 'utf8'));
          rows[0].title = 'Concurrent owner after dry-run';
          ownerText = JSON.stringify(rows);
          await writeFile(join(stack.root, 'data', name + '.json'), ownerText);
          checked = true;
          return { value: { status: 'PASS', requiredFixes: [] } };
        }
        return {
          value: {
            action: 'implement',
            needsVerification: true,
            files: [
              { path: 'site/cms/structure.json', content: JSON.stringify(schema) },
              { path: 'site/cms/data/newRecords.json', content: '[{"id":"one","label":"Fixture"}]' },
            ],
          },
        };
      };
      await assert.rejects(
        workflow(
          project,
          slots,
          'Uprav strukturu',
          join(stack.root, '.sitetiller/drafts'),
          () => {},
          model,
          undefined,
          [],
          { cmsSource: 'unpublished', requestChecks: { technical: false, verification: true } },
        ),
        { status: 409 },
      );
      assert.ok(checked);
      assert.equal(await project.head(), head);
      assert.deepEqual(await readFile(join(stack.root, 'schema/structure.json')), schemaBytes);
      assert.equal(await readFile(join(stack.root, 'data', name + '.json'), 'utf8'), ownerText);
      await assert.rejects(stat(join(stack.root, 'data/newRecords.json')), { code: 'ENOENT' });
      assert.equal(await liveEditing(stack), true);
      assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
    } finally {
      restore();
      await stack.close();
    }
  },
);
