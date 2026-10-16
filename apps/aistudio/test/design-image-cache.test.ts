import './fixtures/field-catalog-server.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { rememberedImages } from '../src/design-image-cache.ts';
import { decodeImage } from '../src/images.ts';
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const slots: any = [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }];
test('AI-26: published collection-image requests stop before model and generation; explicit content intent is honored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-permissions-'));
  const previous = process.env.SITETILLER_CMS_PUBLISHED_ROOT;
  try {
    const cms = join(root, 'cms');
    await mkdir(join(cms, 'schema'), { recursive: true });
    await mkdir(join(cms, 'data'));
    await writeFile(
      join(cms, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: {},
        lists: { sections: { label: 'Oblasti', key: 'id', columns: { id: { type: 'text' } } } },
      }),
    );
    await writeFile(join(cms, 'data/sections.json'), '[]');
    process.env.SITETILLER_CMS_PUBLISHED_ROOT = cms;
    const project = new Project(join(root, 'project'));
    await project.init(null);
    let called = 0;
    const before = await project.head();
    const result = await workflow(
      project,
      slots,
      'Vytvoř nové obrázky pro oblasti.',
      join(root, 'drafts'),
      () => {},
      async () => {
        called++;
        throw Error('Should not call model');
      },
      undefined,
      [],
      { cmsSource: 'published' },
    );
    assert.ok(result.conversationOnly);
    assert.match(result.plan.summary, /Nepublikovaný obsah/);
    assert.equal(called, 0);
    assert.equal(await project.head(), before);
    const classified = await workflow(
      project,
      slots,
      'Změň portrét majitelky',
      join(root, 'drafts'),
      () => {},
      async () =>
        ({
          value: {
            action: 'image',
            requiresContentWrite: true,
            imageEdits: [{ prompt: 'Portrait', purpose: 'content' }],
          },
        }) as any,
      undefined,
      [],
      {
        cmsSource: 'published',
        generate: async () => {
          throw Error('No spending');
        },
      },
    );
    assert.ok(classified.conversationOnly);
  } finally {
    if (previous === undefined) delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    else process.env.SITETILLER_CMS_PUBLISHED_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-26: failed request preserves generated pixels and next request reuses them without generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reusable-images-'));
  const previous = process.env.SITETILLER_CMS_ROOT;
  delete process.env.SITETILLER_CMS_ROOT;
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const image = decodeImage({ data });
    let round = 0,
      generated = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Vytvoř obrázek',
        join(root, 'drafts'),
        () => {},
        async () =>
          ({
            value:
              ++round === 1
                ? { action: 'image', imageEdits: [{ prompt: 'A fixture', format: 'png' }] }
                : { action: 'implement', files: [{ path: 'site/index.html', content: 'invalid html' }] },
          }) as any,
        undefined,
        [],
        {
          model: 'fixture',
          generate: async () => {
            generated++;
            return { ...image, data };
          },
        },
      ),
      /neprošla/,
    );
    assert.equal(generated, 1);
    const cached = await rememberedImages(join(root, 'generated-images'));
    assert.equal(cached.length, 1);
    assert.deepEqual(cached[0].bytes, image.bytes);
    const result = await workflow(
      project,
      slots,
      'Použij hotový obrázek',
      join(root, 'drafts'),
      () => {},
      async (_client, _instruction, input) => {
        assert.equal(input.availableImageAssets[0].path, cached[0].path);
        return {
          value: {
            action: 'implement',
            files: [
              {
                path: 'site/index.html',
                content:
                  '<!doctype html><html><head><title>Image</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><img src="' +
                  cached[0].path.slice(5) +
                  '" alt="Fixture"></body></html>',
              },
            ],
          },
        };
      },
      undefined,
      [],
      {
        requestChecks: { technical: true, verification: false },
        generate: async () => {
          throw Error('Must reuse');
        },
        check: async (path) => {
          assert.deepEqual(await readFile(join(path, cached[0].path)), image.bytes);
          return { passed: true, errors: [], checks: [], screenshots: [] };
        },
      },
    );
    assert.ok(result.commit);
    assert.equal(generated, 1);
    assert.deepEqual(await project.binary(result.commit, cached[0].path), image.bytes);
  } finally {
    if (previous === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
