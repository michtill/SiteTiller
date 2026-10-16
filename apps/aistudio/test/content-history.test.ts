import './fixtures/field-catalog-server.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { deploySite } from '../deploy/site-release.mjs';
test('AI-29: design steps freeze schema, rows, images and documents; publication exports that same snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-history-')),
    old = process.env.SITETILLER_CMS_ROOT;
  let child: any;
  try {
    const cms = join(root, 'cms'),
      studio = join(root, 'studio');
    for (const dir of ['schema', 'data', 'media/images', 'media/docs'])
      await mkdir(join(cms, dir), { recursive: true });
    process.env.SITETILLER_CMS_ROOT = cms;
    const project = new Project(join(studio, 'project'));
    await project.init(null);
    await project.write({
      'site/templates/index.txt':
        '<!doctype html><html><head><title>{{value "items" "one" "title"}}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>{{value "items" "one" "title"}}</main><img src="/cms/files/images/photo.png" alt="Photo"><a href="/cms/files/docs/manual.pdf">PDF</a></body></html>',
      'site/rendering.json': JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/index.txt' } }),
    });
    await project.commit('Rendering fixture');
    const step = async (title: string) => {
      await writeFile(
        join(cms, 'schema/structure.json'),
        JSON.stringify({
          version: title === 'A' ? 1 : 2,
          lists: { items: { label: 'Items', key: 'id', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
          folders: { images: { type: 'img' }, docs: { type: 'other' } },
        }),
      );
      await writeFile(join(cms, 'data/items.json'), JSON.stringify([{ id: 'one', title }]));
      await writeFile(join(cms, 'media/images/photo.png'), Buffer.from('image-' + title));
      await writeFile(join(cms, 'media/docs/manual.pdf'), Buffer.from('%PDF-1.4\n' + title));
      await writeFile(join(cms, 'media/docs/popis.txt'), 'Document ' + title);
      return workflow(
        project,
        [{ provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' }],
        'Uprav styl',
        join(studio, 'drafts'),
        () => {},
        async () => ({
          value: {
            action: 'implement',
            files: [{ path: 'site/style-' + title + '.css', content: 'body{--step:"' + title + '"}' }],
          },
        }),
        undefined,
        [],
        { cmsSource: 'unpublished', requestChecks: { technical: false, verification: false } },
      );
    };
    const a = await step('A'),
      b = await step('B');
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"CURRENT"}]');
    await writeFile(join(cms, 'media/images/photo.png'), 'current image');
    await writeFile(join(cms, 'media/docs/manual.pdf'), '%PDF-current');
    const port = 20800 + Math.floor(Math.random() * 200),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/preview.ts', import.meta.url))], {
      env: { ...process.env, SITETILLER_DATA_DIR: studio, PORT: String(port), HOST: '127.0.0.1' },
      stdio: 'ignore',
      windowsHide: true,
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(origin + '/health')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready);
    for (const [commit, title] of [
      [a.commit, 'A'],
      [b.commit, 'B'],
    ]) {
      const prefix = origin + '/snapshots/versions/' + commit + '/';
      const html = await fetch(prefix).then((r) => r.text());
      assert.ok(html.includes('<main>' + title + '</main>'));
      assert.ok(!html.includes('CURRENT'));
      const picture = await fetch(prefix + 'cms/files/images/photo.png');
      assert.equal(picture.status, 200);
      assert.equal(await picture.text(), 'image-' + title);
      const pdf = await fetch(prefix + 'cms/files/docs/manual.pdf');
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(await pdf.text(), '%PDF-1.4\n' + title);
      assert.equal(await fetch(prefix + 'cms/files/docs/popis.txt').then((r) => r.text()), 'Document ' + title);
      const schema = await fetch(prefix + 'cms/structure.json').then((r) => r.json());
      assert.equal(schema.version, title === 'A' ? 1 : 2);
    }
    const oldWithCurrentSelector = await fetch(origin + '/sources/unpublished/versions/' + a.commit + '/').then((r) =>
      r.text(),
    );
    assert.ok(oldWithCurrentSelector.includes('<main>A</main>'));
    const deployed = await deploySite(project, a.commit, join(root, 'production'));
    assert.equal(
      await readFile(join(deployed, 'cms/data/items.json'), 'utf8'),
      JSON.stringify([{ id: 'one', title: 'A' }], null, 2),
    );
    assert.equal(await readFile(join(deployed, 'cms/files/docs/manual.pdf'), 'utf8'), '%PDF-1.4\nA');
    assert.equal(await readFile(join(deployed, 'cms/files/images/photo.png'), 'utf8'), 'image-A');
    assert.equal(await readFile(join(cms, 'data/items.json'), 'utf8'), '[{"id":"one","title":"CURRENT"}]');
  } finally {
    child?.kill();
    if (old === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = old;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
