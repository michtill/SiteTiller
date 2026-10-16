import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { liveCms } from '../src/cms-live.ts';
test('AI-29: Live CMS reads changed records and new/replaced media without a new SiteTiller task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-live-'));
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await mkdir(join(root, 'media/photos'), { recursive: true });
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({ lists: { pages: {} }, folders: { photos: {} } }),
    );
    const data = join(root, 'data/pages.json');
    await writeFile(data, '[{"title":"Before"}]');
    assert.match((await liveCms('cms/data/pages.json', root)).body.toString(), /Before/);
    await writeFile(data, '[{"title":"After"}]');
    assert.match((await liveCms('cms/data/pages.json', root)).body.toString(), /After/);
    const image = join(root, 'media/photos/Photo.PNG');
    await writeFile(image, 'first');
    const hash = createHash('sha256').update('photos/Photo.PNG').digest('hex').slice(0, 16) + '.png';
    assert.equal((await liveCms('cms/media/' + hash, root)).body.toString(), 'first');
    await writeFile(image, 'replaced');
    assert.equal((await liveCms('cms/media/' + hash, root)).body.toString(), 'replaced');
    await writeFile(join(root, 'media/photos/new.png'), 'new');
    assert.equal((await liveCms('cms/files/photos/new.png', root)).body.toString(), 'new');
    for (const path of [
      'cms/data/secrets.json',
      'cms/files/../schema/structure.json',
      'cms/files/photos/../../secret',
      'cms/files/photos/a:b.png',
    ])
      assert.equal((await liveCms(path, root)).status, 404);
    assert.equal(await liveCms('index.html', root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
