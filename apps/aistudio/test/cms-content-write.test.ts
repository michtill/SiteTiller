import { applyDesignContent } from '../src/cms-content-write.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { fieldCatalog } from '../../cmstudio/field-catalog.ts';
import { assertCmsChanges } from '../src/cms-source.ts';
test('AI-29: draft content writes only after checks and published content remains protected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-content-'));
  const vars = [
    'SITETILLER_CMS_ROOT',
    'SITETILLER_CMS_URL',
    'SITETILLER_CMS_PUBLISHED_ROOT',
    'SITETILLER_PRODUCTION_DIRECTORY',
  ];
  const previous = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  let server: any;
  try {
    const cms = join(root, 'cms');
    await mkdir(join(cms, 'schema'), { recursive: true });
    await mkdir(join(cms, 'data'));
    const schema = {
      version: 1,
      folders: {},
      lists: { pages: { key: 'id', label: 'Pages', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
    };
    await writeFile(join(cms, 'schema/structure.json'), JSON.stringify(schema));
    const data = join(cms, 'data/pages.json');
    await writeFile(data, '[{"id":"one","title":"Before"}]');
    process.env.SITETILLER_CMS_ROOT = cms;
    process.env.SITETILLER_CMS_PUBLISHED_ROOT = cms;
    delete process.env.SITETILLER_PRODUCTION_DIRECTORY;
    const calls: any[] = [];
    let checksPassed = false,
      live = true,
      conflict = false;
    server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/field-catalog') {
        res.end(JSON.stringify(fieldCatalog));
        return;
      }
      if (req.url === '/api/bootstrap') {
        res.end(JSON.stringify({ token: 'fixture' }));
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      calls.push(body);
      assert.equal(req.headers['x-cms-token'], 'fixture');
      if (body.dryRun) {
        assert.equal(await readFile(data, 'utf8'), '[{"id":"one","title":"Before"}]');
        res.end('{}');
        return;
      }
      assert.ok(checksPassed);
      if (conflict) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Conflict fixture' }));
        return;
      }
      live = false;
      await writeFile(data, JSON.stringify(body.changes[0].rows));
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + server.address().port;
    await applyDesignContent(
      { revisions: { pages: 'fixture' }, files: { 'site/cms/data/pages.json': '[{"id":"one","title":"Before"}]' } },
      { 'site/cms/data/pages.json': '[ {"title":"Before", "id":"one"} ]' },
      false,
    );
    assert.equal(calls.length, 0);
    assert.ok(live);
    const permission = { readOnly: false, collections: { pages: {} } };
    assert.doesNotThrow(() => assertCmsChanges({ files: [{ path: 'site/cms/data/pages.json' }] }, permission));
    for (const value of [
      { files: [{ path: 'site/cms/structure.json' }] },
      { files: [{ path: 'site/cms/data/unknown.json' }] },
      { deleteFiles: ['site/cms/data/pages.json'] },
      { imageEdits: [{ target: 'site/cms/media/a.png' }] },
    ])
      assert.throws(() => assertCmsChanges(value, permission));
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const slots: any = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }];
    const call: any = async (_client: any, _instruction: any, input: any) => {
      if (input.testResults) {
        assert.ok(input.diff.some((f: any) => f.path === 'site/cms/data/pages.json' && f.before.includes('Before')));
        checksPassed = true;
        return { value: { status: 'PASS', requiredFixes: [] } };
      }
      assert.equal(input.cms.readOnly, false);
      assert.equal(input.cms.sources.published.readOnly, true);
      return {
        value: {
          action: 'implement',
          needsVerification: true,
          files: [{ path: 'site/cms/data/pages.json', content: '[{"id":"one","title":"After"}]' }],
        },
      };
    };
    const check: any = async () => {
      assert.ok(live);
      assert.equal(await readFile(data, 'utf8'), '[{"id":"one","title":"Before"}]');
      return { passed: true, errors: [], checks: [], screenshots: [] };
    };
    await workflow(project, slots, 'Uprav text obsahu', join(root, 'drafts'), () => {}, call, undefined, [], {
      cmsSource: 'unpublished',
      check,
    });
    assert.equal(live, false);
    assert.match(await readFile(data, 'utf8'), /After/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].dryRun, true);
    assert.equal(calls[1].dryRun, false);
    const blocked = await workflow(
      project,
      slots,
      'Uprav text',
      join(root, 'drafts'),
      () => {},
      async () =>
        ({ value: { action: 'implement', files: [{ path: 'site/cms/data/pages.json', content: '[]' }] } }) as any,
      undefined,
      [],
      { cmsSource: 'published', check },
    );
    assert.ok(blocked.conversationOnly);
    assert.match(blocked.plan.summary, /Nepublikovaný obsah/);
    assert.equal(calls.length, 2);
    await writeFile(data, '[{"id":"one","title":"Before"}]');
    checksPassed = false;
    live = true;
    conflict = true;
    const before = await project.head();
    await assert.rejects(
      workflow(project, slots, 'Uprav text obsahu', join(root, 'drafts'), () => {}, call, undefined, [], {
        cmsSource: 'unpublished',
        check,
      }),
      /Conflict fixture/,
    );
    assert.equal(await project.head(), before);
    assert.ok(live);
    assert.match(await readFile(data, 'utf8'), /Before/);
  } finally {
    if (server) await new Promise<void>((r) => server.close(r));
    for (const key of vars) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
