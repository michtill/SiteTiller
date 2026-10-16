import http from 'node:http';
import { fieldCatalog } from '../../cmstudio/field-catalog.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmsSource, assertCmsChanges } from '../src/cms-source.ts';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
test('AI-29: CMS source refreshes content, maps images and protects snapshots throughout workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-cms-')),
    previous = process.env.SITETILLER_CMS_ROOT,
    previousUrl = process.env.SITETILLER_CMS_URL;
  const catalogServer = http.createServer((req, res) => {
    if (req.url !== '/api/field-catalog') {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fieldCatalog));
  });
  await new Promise<void>((resolve) => catalogServer.listen(0, '127.0.0.1', resolve));
  process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + (catalogServer.address() as any).port;
  try {
    const cmsRoot = join(root, 'cms');
    await mkdir(join(cmsRoot, 'schema'), { recursive: true });
    await mkdir(join(cmsRoot, 'data'));
    await mkdir(join(cmsRoot, 'media/images'), { recursive: true });
    await writeFile(
      join(cmsRoot, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: { images: { type: 'img', label: 'Images' } },
        lists: { pages: { label: 'Pages', columns: { id: { type: 'text' } }, key: 'id' } },
      }),
    );
    const data = join(cmsRoot, 'data/pages.json');
    await writeFile(data, '[{"id":"first"}]');
    await writeFile(join(cmsRoot, 'media/images/PHOTO.PNG'), Buffer.from('image'));
    const source = await cmsSource(cmsRoot);
    assert.equal(source.context.collections.pages.count, 1);
    assert.match(source.context.media[0].path, /\.png$/);
    assert.deepEqual(Object.values(source.binary)[0], Buffer.from('image'));
    await writeFile(data, '[{"id":"second"}]');
    assert.match((await cmsSource(cmsRoot)).files['site/cms/data/pages.json'], /second/);
    assert.throws(() => assertCmsChanges({ files: [{ path: 'site/cms/data/pages.json' }] }), /pouze pro čtení/);
    assert.throws(() => assertCmsChanges({ deleteFiles: ['site/cms/structure.json'] }), /pouze pro čtení/);
    process.env.SITETILLER_CMS_ROOT = cmsRoot;
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.commit({ 'site/cms/data/pages.json': '[{"id":"old"}]' }, 'Old CMS snapshot');
    let supplied = false,
      verified = false;
    const result = await workflow(
      project,
      [{ provider: 'openai', key: 'test', highModel: 'test', lowModel: 'test' }],
      'Uprav vzhled',
      join(root, 'drafts'),
      () => {},
      async (client, instruction, input) => {
        if (input.testResults) {
          verified = true;
          assert.equal(input.cms.snapshotRefreshByHost, true);
          assert.ok(input.diff.every((f: any) => !f.path.startsWith('site/cms/')));
          return { value: { status: 'PASS', requiredFixes: [] } };
        }
        supplied = true;
        assert.equal(input.cms.readOnly, true);
        return {
          value: {
            action: 'implement',
            acceptance: [
              {
                id: 'presentation',
                category: 'required',
                basis: 'User request',
                description: 'Display CMS presentation',
              },
            ],
            files: [
              {
                path: 'site/index.html',
                content:
                  '<!doctype html><html><head><title>Test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>CMS presentation</body></html>',
              },
            ],
          },
        };
      },
      undefined,
      [],
      {
        mode: 'redesign',
        check: async () => ({
          passed: true,
          errors: [],
          checks: [],
          screenshots: [],
          interactions: [],
          imageEvidence: [],
        }),
      } as any,
    );
    assert.ok(supplied);
    assert.ok(verified);
    assert.ok(result.commit);
    assert.match((await project.files())['site/cms/data/pages.json'], /second/);
    assert.equal(await readFile(data, 'utf8'), '[{"id":"second"}]');
  } finally {
    await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.SITETILLER_CMS_URL;
    else process.env.SITETILLER_CMS_URL = previousUrl;
    if (previous === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('AI-29: PDF is a usable website asset without image processing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-pdf-'));
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'media/docs'), { recursive: true });
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({ lists: {}, folders: { docs: { type: 'file' } } }),
    );
    const bytes = Buffer.from('%PDF-test');
    await writeFile(join(root, 'media/docs/document.pdf'), bytes);
    const source = await cmsSource(root),
      asset = source.context.media[0];
    assert.equal(asset.available, true);
    assert.equal(asset.kind, 'file');
    assert.equal(asset.imageProcessingSupported, false);
    assert.equal(asset.source, 'docs/document.pdf');
    assert.deepEqual(source.binary[asset.path], bytes);
    assert.equal(source.files[asset.path], '[Binary content asset]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
