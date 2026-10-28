import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
import { defaults } from '../src/core.ts';
import { withIconLinks, siteIconLinks } from '../src/site-icon.ts';
// A solid 300×200 PNG (not square: the icon takes its centre square).
function png(width: number, height: number) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4),
      sum = Buffer.alloc(4),
      body = Buffer.concat([Buffer.from(type), data]);
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const size = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test('AI-39: Prepare the website icon makes favicon.ico, favicon-32.png and apple-touch-icon.png from one image and links them in every page; the original stays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'site-icon-')),
    logo = png(300, 200);
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    const page = (title: string) =>
      `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><img src="/assets/logo.png" alt="Logo"></main></body></html>`;
    await project.write({ 'site/index.html': page('Pekárna'), 'site/o-nas/index.html': page('O nás') });
    await project.writeBinary?.('site/assets/logo.png', logo);
    if (!project.writeBinary) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(project.root, 'site/assets'), { recursive: true });
      await writeFile(join(project.root, 'site/assets/logo.png'), logo);
    }
    const base = await project.commit('Fixture website');
    let calls = 0;
    const model: any = async (_client: any, _instruction: any, data: any) => {
      if (++calls === 1) {
        return { value: { action: 'site_icon', source: 'site/assets/logo.png', summary: 'Ikona webu je připravená.' } };
      }
      // The Web Lead finishes the prepared candidate; a verifier, when asked, passes it.
      if (data.roleState) return { value: { action: 'implement', files: [], summary: 'Ikona webu je připravená.' } };
      return { value: { status: 'PASS', requiredFixes: [] } };
    };
    const result = await workflow(
      project,
      [{ provider: 'openai' as const, key: 'test', ...defaults.openai }],
      'Připrav ikonu webu z loga.',
      join(root, 'drafts'),
      () => {},
      model,
      undefined,
      [],
      { check: (async () => ({ passed: true, errors: [], checks: [], screenshots: [] })) as any },
    );
    assert.notEqual(result.commit, base);
    const files = await project.committedFiles(result.commit);
    for (const path of ['site/favicon.ico', 'site/favicon-32.png', 'site/apple-touch-icon.png'])
      assert.ok(Object.hasOwn(files, path), path);
    assert.deepEqual(size(await project.binary(result.commit, 'site/favicon-32.png')), [32, 32]);
    assert.deepEqual(size(await project.binary(result.commit, 'site/apple-touch-icon.png')), [180, 180]);
    // The .ico holds the 32×32 PNG behind its 22-byte header.
    const icon = await project.binary(result.commit, 'site/favicon.ico');
    assert.deepEqual([icon.readUInt16LE(2), icon.readUInt16LE(4), icon[6], icon[7]], [1, 1, 32, 32]);
    assert.deepEqual(size(icon.subarray(22)), [32, 32]);
    for (const path of ['site/index.html', 'site/o-nas/index.html'])
      assert.ok(files[path].includes(siteIconLinks), path);
    assert.deepEqual(await project.binary(result.commit, 'site/assets/logo.png'), logo);
    // A page that already links an icon keeps it.
    const own = '<html><head><link rel="shortcut icon" href="/mine.ico"></head><body></body></html>';
    assert.deepEqual(withIconLinks({ 'site/a.html': own }), {});
    // The completeness check then finds the icon.
    const { completenessChecks } = await import('../src/completeness.ts');
    const checkRoot = await mkdtemp(join(tmpdir(), 'site-icon-check-'));
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(checkRoot, path, '..'), { recursive: true });
        await writeFile(
          join(checkRoot, path),
          text === '[Binary image asset]' || /\.(ico|png)$/.test(path)
            ? await project.binary(result.commit, path)
            : text,
        );
      }
      const checked = await completenessChecks(checkRoot, files);
      const face = checked.groups.find((g) => g.id === 'face')!.items;
      assert.equal(face.find((i) => i.id === 'icon')!.ok, true);
      assert.equal(face.find((i) => i.id === 'touch_icon')!.ok, true);
    } finally {
      await rm(checkRoot, { recursive: true, force: true });
    }
    assert.ok(await readFile(join(project.root, 'site/assets/logo.png')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
