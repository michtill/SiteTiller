import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { captureCmsPublication } from '../src/cms-publication.ts';
import { productionSnapshot } from '../src/production-snapshot.ts';
import { storeProductionRelease, productionReleases } from '../src/production-history.ts';
import { deploySite } from '../deploy/site-release.mjs';
import { websiteServer } from '../src/website-server.ts';
test('PU-09: local production freezes CMS and PDF in Git and deployed website independently of later edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-production-'));
  let server: any;
  const oldCms = process.env.SITETILLER_CMS_ROOT;
  try {
    const cms = join(root, 'cms');
    for (const d of ['schema', 'data', 'media/files']) await mkdir(join(cms, d), { recursive: true });
    await writeFile(
      join(cms, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: { files: { type: 'other', label: 'Files' } },
        lists: { items: { key: 'id', columns: { id: { type: 'text' }, title: { type: 'text' } } } },
      }),
    );
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Published"}]');
    const pdf = Buffer.from('%PDF-1.7\nfixture\0');
    await writeFile(join(cms, 'media/files/test.pdf'), pdf);
    await writeFile(join(cms, 'media/files/UPPER.PNG'), Buffer.from('png fixture'));
    const project = new Project(join(root, 'draft'));
    await project.init(null);
    await captureCmsPublication(project, cms);
    const commit = await project.head(),
      target = new Project(join(root, 'production'));
    await target.init(null);
    const published = await productionSnapshot(target, commit, null, project);
    await target.git(['update-ref', 'refs/heads/main', published]);
    await storeProductionRelease(target, { number: 1, description: 'Test' }, published, commit);
    assert.equal((await productionReleases(target))[0].sourceCommit, commit);
    const dir = await deploySite(project, commit, join(root, 'deploy'));
    assert.equal(JSON.parse(await readFile(join(dir, 'cms/data/items.json'), 'utf8'))[0].title, 'Published');
    assert.deepEqual(await readFile(join(dir, 'cms/files/files/test.pdf')), pdf);
    await writeFile(join(cms, 'data/items.json'), '[{"id":"one","title":"Draft only"}]');
    delete process.env.SITETILLER_CMS_ROOT;
    server = websiteServer(dir, 'http://127.0.0.1');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + (server.address() as any).port;
    const upper = await fetch(origin + '/cms/files/files/UPPER.PNG');
    assert.equal(upper.status, 200);
    assert.equal(upper.headers.get('content-type'), 'image/png');
    assert.equal((await (await fetch(origin + '/cms/data/items.json')).json())[0].title, 'Published');
    assert.deepEqual(Buffer.from(await (await fetch(origin + '/cms/files/files/test.pdf')).arrayBuffer()), pdf);
    // The AI's internal description of the website is never public.
    await writeFile(join(dir, 'architecture.txt'), 'Architektura webu (nezveřejněný návrh)');
    assert.equal((await fetch(origin + '/architecture.txt')).status, 404);
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (oldCms === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = oldCms;
    await rm(root, { recursive: true, force: true });
  }
});
