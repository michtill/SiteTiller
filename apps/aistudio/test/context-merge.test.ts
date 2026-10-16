import './fixtures/field-catalog-server.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { selectContext } from '../src/manifest.ts';
test('AI-16: reading a small batch works when already provided CMS context has more than 30 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-merge-')),
    previous = process.env.SITETILLER_CMS_ROOT;
  try {
    const cms = join(root, 'cms');
    await mkdir(join(cms, 'schema'), { recursive: true });
    await mkdir(join(cms, 'data'));
    await mkdir(join(cms, 'media/images'), { recursive: true });
    await writeFile(
      join(cms, 'schema/structure.json'),
      JSON.stringify({ version: 1, lists: {}, folders: { images: { type: 'img' } } }),
    );
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
      'base64',
    );
    for (let i = 0; i < 31; i++) await writeFile(join(cms, 'media/images', 'image-' + i + '.png'), bytes);
    process.env.SITETILLER_CMS_ROOT = cms;
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({ 'site/js/app.js': '// requested script' });
    await project.commit('Fixture script');
    let calls = 0;
    const result = await workflow(
      project,
      [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
      'Jak je připraveno barevné schéma?',
      join(root, 'drafts'),
      () => {},
      async (_client, _instruction, input) => {
        assert.ok(Object.keys(input.files).length > 30);
        if (++calls === 1) return { value: { action: 'read', paths: ['site/js/app.js'] } };
        assert.equal(input.files['site/js/app.js'], '// requested script');
        assert.equal(input.feedback, null);
        return { value: { action: 'answer', summary: 'Script loaded.' } };
      },
      undefined,
      [],
      { cmsSource: 'unpublished' },
    );
    assert.ok(result.conversationOnly);
    assert.equal(calls, 2);
    assert.throws(
      () =>
        selectContext(
          Object.fromEntries(Array.from({ length: 31 }, (_, i) => ['site/file-' + i + '.txt', 'x'])),
          Array.from({ length: 31 }, (_, i) => 'site/file-' + i + '.txt'),
        ),
      /výběr kontextu/,
    );
  } finally {
    if (previous === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
