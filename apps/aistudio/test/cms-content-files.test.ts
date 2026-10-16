import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { stageContentFiles } from '../src/cms-content-files.ts';
import { decodeAttachment } from '../src/images.ts';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { fieldCatalog } from '../../cmstudio/field-catalog.ts';
test('AI-29: files stage without writing, respect source permissions and preserve exact attachment bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-files-'));
  try {
    const pdf = Buffer.from('%PDF-1.4\nfixture bytes\n');
    const source = { readOnly: false, schema: { folders: { docs: { type: 'other' } } }, media: [] };
    const files = { 'site/assets/manual.pdf': '[Binary image asset]' };
    const binaries = {},
      assets: any[] = [];
    const transfer = [{ source: 'site/assets/manual.pdf', folder: 'docs', name: 'manual.pdf' }];
    await assert.rejects(
      stageContentFiles(transfer, { ...source, readOnly: true }, root, files, binaries, assets),
      /pouze pro čtení/,
    );
    await assert.rejects(
      stageContentFiles([{ ...transfer[0], folder: 'unknown' }], source, root, files, binaries, assets),
      /definovaná/,
    );
    await assert.rejects(
      stageContentFiles([{ ...transfer[0], name: '../a.pdf' }], source, root, files, binaries, assets),
      /název/,
    );
    await stageContentFiles(transfer, source, root, files, binaries, assets, [
      { path: transfer[0].source, data: pdf.toString('base64') },
    ]);
    assert.deepEqual(binaries['site/cms/files/docs/manual.pdf'], pdf);
    assert.equal(assets.length, 1);
    await assert.rejects(readFile(join(root, 'site/cms/files/docs/manual.pdf')), (e) => e.code === 'ENOENT');
    await stageContentFiles(transfer, source, root, files, binaries, assets);
    assert.equal(assets.length, 1);
    assert.deepEqual(decodeAttachment({ name: 'manual.pdf', data: pdf.toString('base64') }).bytes, pdf);
    assert.throws(
      () => decodeAttachment({ name: 'manual.pdf', data: Buffer.from('not PDF').toString('base64') }),
      /PDF/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-29: workflow saves a PDF into content folders only after validation and browser checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-transfer-'));
  const previous = Object.fromEntries(['SITETILLER_CMS_ROOT', 'SITETILLER_CMS_URL'].map((k) => [k, process.env[k]]));
  let server: any;
  try {
    const cms = join(root, 'cms');
    await mkdir(join(cms, 'schema'), { recursive: true });
    await mkdir(join(cms, 'data'));
    await writeFile(
      join(cms, 'schema/structure.json'),
      JSON.stringify({ version: 1, lists: {}, folders: { docs: { type: 'other', label: 'Documents' } } }),
    );
    process.env.SITETILLER_CMS_ROOT = cms;
    const pdf = Buffer.from('%PDF-1.4\nattachment fixture\n');
    let checked = false;
    const calls: any[] = [];
    server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/field-catalog') {
        res.end(JSON.stringify(fieldCatalog));
        return;
      }
      if (req.url === '/api/bootstrap') {
        res.end('{"token":"fixture"}');
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      calls.push(body);
      assert.equal(body.assets[0].folder, 'docs');
      assert.deepEqual(Buffer.from(body.assets[0].data, 'base64'), pdf);
      if (!body.dryRun) {
        assert.ok(checked);
        await mkdir(join(cms, 'media/docs'), { recursive: true });
        await writeFile(join(cms, 'media/docs/manual.pdf'), pdf);
      }
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + server.address().port;
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const attachment = {
      id: 'attachment.pdf',
      name: 'manual.pdf',
      mime: 'application/pdf',
      data: pdf.toString('base64'),
      use: 'website',
    };
    const result = await workflow(
      project,
      [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
      'Přidej soubor do složky',
      join(root, 'drafts'),
      () => {},
      async (_client, _instruction, input) => {
        assert.ok(!input._images.some((image: any) => image.mime === 'application/pdf'));
        return {
          value: {
            action: 'implement',
            files: [],
            contentFiles: [{ source: 'site/assets/attachment.pdf', folder: 'docs', name: 'manual.pdf' }],
          },
        };
      },
      undefined,
      [attachment],
      {
        cmsSource: 'unpublished',
        requestChecks: { technical: true, verification: false },
        check: async (path) => {
          assert.deepEqual(await readFile(join(path, 'site/cms/files/docs/manual.pdf')), pdf);
          await assert.rejects(readFile(join(cms, 'media/docs/manual.pdf')), (e) => e.code === 'ENOENT');
          checked = true;
          return { passed: true, errors: [], checks: [], screenshots: [] };
        },
      },
    );
    assert.ok(result.commit);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].dryRun);
    assert.equal(calls[1].dryRun, false);
    assert.deepEqual(await readFile(join(cms, 'media/docs/manual.pdf')), pdf);
    assert.deepEqual(await project.binary(result.commit, 'site/cms/files/docs/manual.pdf'), pdf);
  } finally {
    if (server) await new Promise<void>((r) => server.close(r));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
