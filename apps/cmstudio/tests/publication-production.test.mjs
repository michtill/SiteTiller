import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Publication } from '../server/publication.ts';
import { Store } from '../server/store.ts';
const root = await mkdtemp(join(tmpdir(), 'cms-prod-'));
try {
  const schema = {
    version: 1,
    lists: {
      items: {
        key: 'id',
        label: 'Items',
        columns: { id: { type: 'text', label: 'ID' }, title: { type: 'text', label: 'Title' } },
      },
    },
    folders: {},
  };
  for (const p of ['schema', 'data', '.production/release/cms/data']) await mkdir(join(root, p), { recursive: true });
  await writeFile(join(root, 'schema/structure.json'), JSON.stringify(schema));
  await writeFile(join(root, 'data/items.json'), '[{"id":"one","title":"Draft"}]');
  await writeFile(join(root, '.production/release/cms/structure.json'), JSON.stringify(schema));
  await writeFile(join(root, '.production/release/cms/data/items.json'), '[{"id":"one","title":"Published"}]');
  await writeFile(join(root, '.production/release/index.html'), 'UNCHANGED DESIGN');
  await writeFile(
    join(root, '.production/current.json'),
    JSON.stringify({ id: 'old', commit: 'old-design', directory: join(root, '.production/release') }),
  );
  const pub = new Publication(root, new Store(root), join(root, '.production'));
  await pub.initialize();
  assert.equal(JSON.parse((await pub.asset('data/items.json')).bytes)[0].title, 'Published');
  assert.equal((await pub.status()).unpublished, true);
  await pub.publish();
  const state = JSON.parse(await readFile(join(root, '.production/current.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(state.directory, 'cms/data/items.json'), 'utf8'))[0].title, 'Draft');
  assert.equal(await readFile(join(state.directory, 'index.html'), 'utf8'), 'UNCHANGED DESIGN');
  assert.equal(state.cmsRevision, (await pub.pointer()).revision);
  const workingBefore = await readFile(join(root, 'data/items.json'), 'utf8');
  await mkdir(join(root, '.production/design-new/cms/data'), { recursive: true });
  await writeFile(join(root, '.production/design-new/cms/structure.json'), JSON.stringify(schema));
  await writeFile(
    join(root, '.production/design-new/cms/data/items.json'),
    '[{"id":"one","title":"Design published"}]',
  );
  await writeFile(
    join(root, '.production/current.json'),
    JSON.stringify({ ...state, id: 'design-new', directory: join(root, '.production/design-new') }),
  );
  const synced = await pub.status();
  assert.equal(synced.published.importedFromProduction, 'design-new');
  assert.equal(synced.unpublished, true);
  assert.equal(JSON.parse((await pub.asset('data/items.json')).bytes)[0].title, 'Design published');
  assert.equal(await readFile(join(root, 'data/items.json'), 'utf8'), workingBefore);
  const stable = (await pub.status()).published.id;
  assert.equal((await pub.status()).published.id, stable);
  await writeFile(join(root, '.production/design-new/cms/data/items.json'), workingBefore);
  await writeFile(
    join(root, '.production/current.json'),
    JSON.stringify({ id: 'design-working', directory: join(root, '.production/design-new') }),
  );
  assert.equal((await pub.status()).unpublished, false);
  assert.equal(await readFile(join(root, 'data/items.json'), 'utf8'), workingBefore);
  // A published website without content (an older static site) leaves the published content as it is.
  const before = (await pub.status()).published;
  await mkdir(join(root, '.production/static-site'), { recursive: true });
  await writeFile(join(root, '.production/static-site/index.html'), 'STATIC');
  await writeFile(
    join(root, '.production/current.json'),
    JSON.stringify({ id: 'static', directory: join(root, '.production/static-site') }),
  );
  await pub.initialize();
  assert.deepEqual((await pub.status()).published, before);
  console.log(
    'PASS bootstrap uses production, draft preserved, CMS publish updates production, appearance unchanged, matching revision',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
