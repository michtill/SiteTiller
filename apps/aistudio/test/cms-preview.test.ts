import './fixtures/field-catalog-server.ts';
import { captureCmsPublication, capturePublicationSource } from '../src/cms-publication.ts';
import { workflow } from './fixtures/workflow.ts';
import { Project } from '../src/project.ts';
import { designContentMode } from '../src/cms-design-source.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmsPreviewRoute, previewCmsFiles, previewCmsAsset, cmsPreviewAvailable } from '../src/cms-preview.ts';
import { renderCmsPage } from '../src/cms-render.ts';
test('AI-29: preview sources separate published and draft schema, rows and assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-sources-'));
  const vars = ['SITETILLER_CMS_ROOT', 'SITETILLER_PRODUCTION_DIRECTORY', 'SITETILLER_CMS_PUBLISHED_ROOT'],
    old = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  try {
    const draft = join(root, 'draft'),
      production = join(root, 'production'),
      release = join(production, 'release');
    await mkdir(join(draft, 'schema'), { recursive: true });
    await mkdir(join(draft, 'data'));
    await mkdir(join(draft, 'media', 'images'), { recursive: true });
    await mkdir(join(release, 'cms', 'data'), { recursive: true });
    await mkdir(join(release, 'cms', 'files', 'images'), { recursive: true });
    const schema = { settings: { name: 'SECRET' }, lists: { items: { key: 'id' } }, folders: { images: {} } };
    await writeFile(join(draft, 'schema', 'structure.json'), JSON.stringify(schema));
    await writeFile(join(release, 'cms', 'structure.json'), JSON.stringify({ ...schema, version: 7 }));
    await writeFile(join(draft, 'data', 'items.json'), JSON.stringify([{ id: 'one', title: 'Unpublished title' }]));
    await writeFile(
      join(release, 'cms', 'data', 'items.json'),
      JSON.stringify([{ id: 'one', title: 'Published title' }]),
    );
    await writeFile(join(draft, 'media', 'images', 'photo.png'), 'draft-image');
    await writeFile(join(release, 'cms', 'files', 'images', 'photo.png'), 'published-image');
    await writeFile(join(production, 'current.json'), JSON.stringify({ directory: release }));
    process.env.SITETILLER_CMS_ROOT = draft;
    process.env.SITETILLER_PRODUCTION_DIRECTORY = production;
    delete process.env.SITETILLER_CMS_PUBLISHED_ROOT;
    await mkdir(join(draft, '.cms-publication'), { recursive: true });
    await writeFile(join(draft, '.cms-publication', 'current.json'), JSON.stringify({ directory: draft }));
    assert.deepEqual(await cmsPreviewAvailable(), { published: true, unpublished: true });
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await captureCmsPublication(project, join(release, 'cms'), true);
    assert.match((await project.files())['site/cms/data/items.json'], /Published title/);
    await captureCmsPublication(project, draft);
    const historical = await project.head();
    assert.match((await project.files())['site/cms/data/items.json'], /Unpublished title/);
    await project.write({ 'site/newer.txt': 'Newer design preserved' });
    const newer = await project.commit('Newer design');
    const capturedVersion = await capturePublicationSource(project, historical, newer, join(release, 'cms'), true);
    assert.match((await project.committedFiles(capturedVersion.commit))['site/cms/data/items.json'], /Published title/);
    assert.equal((await project.files())['site/newer.txt'], 'Newer design preserved');
    assert.match((await project.files())['site/cms/data/items.json'], /Unpublished title/);
    for (const mode of ['published', 'unpublished'] as const) {
      let seen = false;
      const result = await workflow(
        project,
        [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
        'Which content is selected?',
        join(root, 'drafts'),
        () => {},
        async (_client, _instruction, input) => {
          seen = true;
          assert.equal(input.cms.sourceMode, mode);
          assert.equal(input.cms.selectedSource, mode);
          assert.equal(input.cms.sources.published.collections.items[0].title, 'Published title');
          assert.equal(input.cms.sources.unpublished.collections.items[0].title, 'Unpublished title');
          assert.equal(input.cms.sources[mode].selectedForDesign, true);
          assert.equal(input.cms.sources.published.schema.settings, undefined);
          assert.equal(input.cms.sources.unpublished.schema.settings, undefined);
          assert.equal(input.cms.readOnly, mode === 'published');
          assert.match(
            input.files['site/cms/data/items.json'],
            new RegExp(mode === 'published' ? 'Published title' : 'Unpublished title'),
          );
          assert.match(input.cms.instruction, /explicitly selected/);
          return { value: { action: 'answer', summary: 'Selected content confirmed' } };
        },
        undefined,
        [],
        { cmsSource: mode },
      );
      assert.ok(seen);
      assert.equal(result.conversationOnly, true);
    }
    assert.throws(() => designContentMode('other'));
    const files = {
      'site/index.html': 'fallback',
      'site/templates/index.txt':
        '<html><head><title>{{value "items" "one" "title"}}</title></head><body><h1>{{value "items" "one" "title"}}</h1></body></html>',
      'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/index.txt' } }),
      'site/cms/data/stale.json': '[]',
    };
    const frozen = await previewCmsFiles(files, 'published');
    assert.ok(!frozen['site/cms/data/stale.json']);
    assert.ok(!frozen['site/cms/structure.json'].includes('SECRET'));
    assert.match(await renderCmsPage('site/index.html', frozen), /<h1>Published title/);
    assert.match(await renderCmsPage('site/index.html', files, true), /<h1>Unpublished title/);
    assert.equal(
      (await previewCmsAsset('cms/files/images/photo.png', 'published'))?.body.toString(),
      'published-image',
    );
    assert.equal((await previewCmsAsset('cms/files/images/photo.png', 'unpublished'))?.body.toString(), 'draft-image');
    assert.equal((await previewCmsAsset('cms/files/images/../../current.json', 'published'))?.status, 404);
    await writeFile(join(draft, 'data', 'items.json'), JSON.stringify([{ id: 'one', title: 'Changed draft' }]));
    assert.match(await renderCmsPage('site/index.html', await previewCmsFiles(files, 'published')), /Published title/);
    assert.match(await renderCmsPage('site/index.html', files, true), /Changed draft/);
    assert.deepEqual(cmsPreviewRoute('sources/published/versions/abc/index.html'), {
      mode: 'published',
      route: 'versions/abc/index.html',
      sourcePrefix: 'sources/published/',
    });
    assert.equal(cmsPreviewRoute('versions/abc/').mode, undefined);
  } finally {
    for (const key of vars) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
