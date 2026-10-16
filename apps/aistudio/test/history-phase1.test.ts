import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { stepChanges, presentationState } from '../src/step-changes.ts';
import { saveNamedDraft, savedDraft, savedDrafts } from '../src/saved-drafts.ts';
import { captureCmsPublication } from '../src/cms-publication.ts';
import { restoredContent } from '../src/restore-content.ts';
import { renderCmsPage } from '../src/cms-render.ts';
import { rebaseWorkspace } from '../src/workspace-history.ts';
import { restoreProduction } from '../src/restore-production.ts';
import { closePublishedHistory } from '../src/publication-history.ts';
import { mapCleanupHistory } from '../src/image-cleanup.ts';
const schema = {
    version: 1,
    folders: { docs: { type: 'file' } },
    lists: { items: { key: 'id', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
  },
  html =
    '<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>{{value "items" "one" "title"}}</h1><a href="/cms/files/docs/book.pdf">PDF</a></main></body></html>';
async function fixture(run: any) {
  const root = await mkdtemp(join(tmpdir(), 'next-history-phase1-')),
    old = process.env.SITETILLER_CMS_ROOT;
  try {
    const cms = join(root, 'cms');
    for (const dir of ['schema', 'data', 'media/docs']) await mkdir(join(cms, dir), { recursive: true });
    await writeFile(join(cms, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Initial"}]');
    await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nInitial');
    process.env.SITETILLER_CMS_ROOT = cms;
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({
      'site/index.html': html.replace(/\{\{[^}]+\}\}/g, 'Entry'),
      'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/home.txt' } }),
      'site/templates/home.txt': html,
      'site/architecture.txt': 'The template uses items.title.',
    });
    await captureCmsPublication(project, cms);
    await run({ root, cms, project, initial: await project.head() });
  } finally {
    if (old === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = old;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
test('AI-03: content/doc/snapshot/media checkpoints keep last presentation head; combined template changes advance it; JSON formatting does not', () =>
  fixture(async ({ project, initial }: any) => {
    await project.write({
      'site/cms/data/items.json': '[{"id":"one","title":"Content changed"}]',
      'site/architecture.txt': 'The template now renders the updated content.',
    });
    const content = await project.commit('Content and doc');
    const result = await stepChanges(project, initial, content);
    assert.equal(result.presentationChanged, false);
    assert.equal(result.changeKind, 'content');
    const config = {
      presentationHead: initial,
      requests: [
        { id: 'presentation', status: 'ready', sequence: 1, commit: initial, presentationChanged: true },
        { id: 'content', status: 'ready', sequence: 2, commit: content, ...result },
      ],
    };
    assert.equal(presentationState(config, content).presentationHead, initial);
    assert.equal(presentationState(JSON.parse(JSON.stringify(config)), content).presentationStepId, 'presentation');
    await project.write({
      'site/templates/home.txt': html.replace('<h1>', '<h1 class="changed">'),
      'site/cms/data/items.json': '[{"id":"one","title":"Both"}]',
    });
    const combined = await project.commit('Combined');
    assert.equal((await stepChanges(project, content, combined)).changeKind, 'combined');
    await project.write({ 'site/cms/data/items.json': '[\n {"title":"Both","id":"one"}\n]' });
    const formatting = await project.commit('Format');
    assert.equal((await stepChanges(project, combined, formatting)).changeKind, 'unchanged');
    const reordered = {
      ...schema,
      lists: { items: { ...schema.lists.items, columns: { title: { type: 'text' }, id: { type: 'text' } } } },
    };
    await project.write({ 'site/cms/structure.json': JSON.stringify(reordered) });
    const structure = await project.commit('Reorder fields');
    const ordering = await stepChanges(project, formatting, structure);
    assert.equal(ordering.changeKind, 'content');
    assert.equal(ordering.presentationChanged, false);
  }));
test('AI-03: actual website binary edits count presentation; private content staging asset sources do not unless used in website code', () =>
  fixture(async ({ project, initial }: any) => {
    await mkdir(join(project.root, 'site/assets'), { recursive: true });
    await writeFile(join(project.root, 'site/assets/staging.png'), Buffer.from([1, 2, 3]));
    await project.write({ 'site/cms/data/items.json': '[{"id":"one","title":"Photo"}]' });
    const stage = await project.commit('Content staging');
    assert.equal((await stepChanges(project, initial, stage, ['site/assets/staging.png'])).presentationChanged, false);
    assert.equal((await stepChanges(project, initial, stage)).presentationChanged, true);
    await project.write({
      'site/templates/home.txt': html.replace('</main>', '<img src="/assets/staging.png"></main>'),
    });
    const used = await project.commit('Use image in design');
    assert.equal((await stepChanges(project, initial, used, ['site/assets/staging.png'])).changeKind, 'combined');
    await writeFile(join(project.root, 'site/assets/staging.png'), Buffer.from([4, 5, 6]));
    const binary = await project.commit('Binary changed');
    assert.equal((await stepChanges(project, used, binary)).presentationChanged, true);
  }));
test('HI-03: save freezes external Editor changes at save time without changing HEAD/work; named refs/schema/rows/PDF survive edits and cleanup/rebase', () =>
  fixture(async ({ root, cms, project, initial }: any) => {
    const selectedSchema = {
      ...schema,
      version: 2,
      lists: { items: { ...schema.lists.items, columns: { ...schema.lists.items.columns, extra: { type: 'text' } } } },
    };
    await writeFile(join(cms, 'schema/structure.json'), JSON.stringify(selectedSchema));
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Saved now","extra":"Complete"}]');
    await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nSaved now');
    const before = await project.git(['status', '--porcelain']),
      draft = await saveNamedDraft(project, {
        name: 'Selected state',
        expectedHead: initial,
        cmsSource: 'unpublished',
        presentationHead: initial,
      });
    assert.equal(await project.head(), initial);
    assert.equal(await project.git(['status', '--porcelain']), before);
    assert.notEqual(draft.commit, initial);
    assert.equal(draft.cmsSource, 'unpublished');
    assert.ok(draft.contentRevision && draft.schemaRevision);
    assert.match(await renderCmsPage('site/index.html', await project.committedFiles(draft.commit)), /Saved now/);
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Future"}]');
    await writeFile(join(cms, 'media/docs/book.pdf'), '%PDF-1.4\nFuture');
    await project.write({ 'site/templates/home.txt': html.replace('<h1>', '<h1 class="future">') });
    const later = await project.commit('Later design');
    const bare = join(root, 'fixture-production.git');
    await mkdir(bare);
    const production = new Project(bare);
    await production.git(['init', '--bare', '-b', 'main']);
    await project.git(['push', bare, initial + ':refs/heads/main']);
    const rebuilt = await rebaseWorkspace(project, production, initial, initial, [later]);
    const config: any = {
      publishedCommit: initial,
      publishedThrough: 1,
      releases: [{ commit: initial, publishedAt: new Date().toISOString() }],
      presentationHead: later,
      requests: [
        { id: 'old', sequence: 1, status: 'ready', commit: initial },
        { id: 'new', sequence: 2, status: 'ready', commit: later },
      ],
    };
    mapCleanupHistory(config, [], rebuilt.mapping);
    closePublishedHistory(config, []);
    assert.equal(config.requests.length, 1);
    assert.equal((await savedDraft(project, draft.id)).commit, draft.commit);
    assert.equal((await savedDrafts(project))[0].name, 'Selected state');
    const restored = await restoredContent(project, draft.commit);
    assert.equal(restored.schema.version, 2);
    assert.equal(restored.collections.items[0].extra, 'Complete');
    assert.equal(Buffer.from(restored.assets[0].data, 'base64').toString(), '%PDF-1.4\nSaved now');
    const head = await project.head(),
      loaded = await restoreProduction(project, project, draft.commit, head);
    assert.equal(
      await project.git(['rev-parse', loaded.commit + ':site']),
      await project.git(['rev-parse', draft.commit + ':site']),
    );
    assert.equal(await production.head(), initial);
    assert.match(await renderCmsPage('site/index.html', await project.committedFiles(draft.commit)), /Saved now/);
  }));
test('HI-03: concurrent source changes abort saving before catalogue/ref insertion; stale HEAD and invalid names fail', () =>
  fixture(async ({ cms, project, initial }: any) => {
    const original = Project.prototype.git;
    let changed = false;
    Project.prototype.git = async function (args: string[]) {
      const result = await original.call(this, args);
      if (!changed && this.root.includes('sitetiller-saved-draft-') && args[0] === 'add') {
        changed = true;
        await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Concurrent"}]');
      }
      return result;
    };
    try {
      await assert.rejects(
        saveNamedDraft(project, { name: 'Race', expectedHead: initial, cmsSource: 'unpublished' }),
        /během ukládání změnily/,
      );
    } finally {
      Project.prototype.git = original;
    }
    assert.equal(await project.head(), initial);
    assert.deepEqual(await savedDrafts(project), []);
    assert.equal(await project.git(['for-each-ref', 'refs/sitetiller/saved-drafts/']), '');
    await assert.rejects(saveNamedDraft(project, { name: '', expectedHead: initial }));
    await assert.rejects(saveNamedDraft(project, { name: 'Stale', expectedHead: 'a'.repeat(40) }), /mezitím změnil/);
  }));
