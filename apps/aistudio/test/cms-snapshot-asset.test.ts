import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cmsSnapshotAsset } from '../src/cms-snapshot-asset.ts';
import { browserChecks, staticChecks } from '../src/checks.ts';
test('AI-29: CMS file URLs resolve frozen media in desktop/mobile technical checks', async () => {
  const ref = 'images/Marketa_web.png',
    path = 'site/cms/media/' + createHash('sha256').update(ref).digest('hex').slice(0, 16) + '.png',
    files = {
      'site/cms/structure.json': JSON.stringify({ folders: { images: { type: 'img' } } }),
      'site/index.html':
        '<!doctype html><html><head><title>CMS asset</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><img src="/cms/files/images/Marketa_web.png" alt="Portrait"></body></html>',
      [path]: '[Binary image asset]',
    };
  assert.equal(cmsSnapshotAsset('cms/files/' + ref, files), path);
  assert.equal(cmsSnapshotAsset('cms/files/images/../Marketa_web.png', files), null);
  assert.equal(cmsSnapshotAsset('cms/files/other/Marketa_web.png', files), null);
  assert.equal(cmsSnapshotAsset('cms/files/images/missing.png', files), null);
  assert.equal(staticChecks(files).passed, true);
  const root = await mkdtemp(join(tmpdir(), 'cms-file-check-'));
  try {
    await mkdir(join(root, 'site/cms/media'), { recursive: true });
    await writeFile(
      join(root, path),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const result = await browserChecks(root, files, [
      {
        name: 'CMS portrait',
        path: 'site/index.html',
        steps: [
          { action: 'expectAttribute', selector: 'img', attribute: 'src', value: '/cms/files/images/Marketa_web.png' },
        ],
      },
    ]);
    assert.equal(result.passed, true, JSON.stringify(result.errors));
    assert.equal(result.checks.length, 2);
    assert.equal(result.scenarios.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
