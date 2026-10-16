import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderCmsPage, renderWithData } from '../src/cms-render.ts';
import { browserChecks, staticChecks } from '../src/checks.ts';
import { Project } from '../src/project.ts';
const schema = {
  settings: { name: 'Private editor' },
  folders: { images: {} },
  lists: { items: { key: 'id', columns: { id: {}, title: {}, body: {} } } },
};
const files = {
  'site/index.html':
    '<!doctype html><html><head><title>Entry</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>Entry</body></html>',
  'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/index.txt' } }),
  'site/templates/index.txt':
    '<!doctype html><html><head><title>{{value "items" "one" "title"}}</title><meta name="description" content="{{value \"items\" \"one\" \"title\"}}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>{{value "items" "one" "title"}}</h1>{{html (value "items" "one" "body")}}</main></body></html>',
  'site/cms/structure.json': JSON.stringify(schema),
  'site/cms/data/items.json': JSON.stringify([
    { id: 'one', title: 'First content', body: '<p>Text</p><script>alert(1)</script>' },
  ]),
};
test('AI-30: server templates escape content, sanitize rich text and exclude editor settings', async () => {
  const html = await renderCmsPage('site/index.html', files);
  assert.match(html, /<h1>First content<\/h1>/);
  assert.ok(!html.includes('Private editor'));
  assert.ok(!html.includes('<script>alert'));
  const unsafe = {
    ...files,
    'site/templates/index.txt': files['site/templates/index.txt'].replace(
      '{{value "items" "one" "title"}}',
      '{{{value "items" "one" "title"}}}',
    ),
  };
  await assert.rejects(renderCmsPage('site/index.html', unsafe), /escaped/);
  assert.equal(staticChecks(files).passed, true);
});
test('AI-30: live CMS changes appear in first HTML and metadata without regeneration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssr-live-')),
    old = process.env.SITETILLER_CMS_ROOT;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
    await writeFile(join(root, 'data/items.json'), files['site/cms/data/items.json']);
    process.env.SITETILLER_CMS_ROOT = root;
    assert.match(await renderCmsPage('site/index.html', files, true), /<h1>First content/);
    await writeFile(
      join(root, 'data/items.json'),
      JSON.stringify([{ id: 'one', title: 'Changed <name>', body: '<p>Changed body</p>' }]),
    );
    const html = await renderCmsPage('site/index.html', files, true);
    assert.match(html, /<h1>Changed &lt;name&gt;<\/h1>/);
    assert.match(html, /<title>Changed &lt;name&gt;<\/title>/);
    assert.match(html, /content="Changed &lt;name&gt;"/);
  } finally {
    if (old === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = old;
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-30: technical browser checks prove initial CMS content without JavaScript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssr-browser-'));
  try {
    const result = await browserChecks(root, files);
    assert.equal(result.passed, true, JSON.stringify(result.errors));
    assert.equal(result.serverRendering.length, 1);
    assert.match(result.serverRendering[0].mainText, /First content/);
    assert.equal(result.serverRendering[0].noJavaScript, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-30: immutable version cache coalesces reads and never caches current CMS values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssr-cache-'));
  try {
    const project = new Project(root);
    await project.init(null);
    const head = await project.head();
    let calls = 0;
    const original = (project as any).readObject.bind(project);
    (project as any).readObject = async (spec: string) => {
      calls++;
      return original(spec);
    };
    const [a, b] = await Promise.all([project.committedFiles(head), project.committedFiles(head)]);
    assert.equal(calls, 1);
    a['site/index.html'] = 'mutation';
    assert.notEqual((await project.committedFiles(head))['site/index.html'], 'mutation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-30: formatted content renders Markdown to sanitized HTML with content images and safe links', async () => {
  const page = {
    ...files,
    'site/templates/index.txt':
      '<!doctype html><html><head><title>T</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>{{markdown (value "items" "one" "body")}}</main></body></html>',
    'site/cms/data/items.json': JSON.stringify([
      {
        id: 'one',
        title: 'T',
        body: '## Nadpis\n\n**Tučně** a *kurzíva*, [odkaz](https://example.cz/) a [zlý](javascript:alert(1)).\n\n- jedna\n- dvě\n\n> citace\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![Fotka](images/a.jpg)\n\n<script>alert(1)</script>',
      },
    ]),
  };
  const html = await renderCmsPage('site/index.html', page);
  assert.match(html, /<h2>Nadpis<\/h2>/);
  assert.match(html, /<strong>Tučně<\/strong> a <em>kurzíva<\/em>/);
  assert.match(html, /<a href="https:\/\/example.cz\/" rel="noopener noreferrer">odkaz<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<ul>\s*<li>jedna<\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr \/>|<hr>/);
  assert.match(html, /<table>[\s\S]*<td>1<\/td>/);
  assert.match(html, /<img src="[^"]*images\/a\.jpg" alt="Fotka" loading="lazy" class="inline-img"/);
  // HTML written into Markdown is text, never markup.
  assert.doesNotMatch(html, /<script>alert/);
});
