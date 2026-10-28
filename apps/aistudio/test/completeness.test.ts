import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { completenessChecks } from '../src/completeness.ts';
// A solid PNG of the given size.
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 90)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function site(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'completeness-'));
  const text: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
    text[path] = typeof content === 'string' ? content : '[Binary image asset]';
  }
  return { root, files: text };
}
const page = (title: string, extra = '', body = '', lang = ' lang="cs"') =>
  `<!doctype html><html${lang}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${extra}</head><body>${body}</body></html>`;
const status = (result: any) =>
  Object.fromEntries(result.groups.flatMap((g: any) => g.items.map((i: any) => [g.id + '.' + i.id, i.ok])));

test('AI-38: the completeness check reports every rule as met on a complete website and as a warning on a bare one; it changes nothing', async () => {
  const head = (path: string, title: string) =>
    `<meta name="description" content="Malé knihkupectví v centru města s výběrem české literatury a dětských knih."><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="canonical" href="https://knihy.example/${path}"><meta property="og:title" content="${title}"><meta property="og:description" content="Knihkupectví v centru města"><meta property="og:image" content="/share.png">`;
  const complete = await site({
    'site/index.html': page(
      'Knihkupectví U Lípy',
      head('', 'Knihkupectví U Lípy'),
      '<main><h1>Knihkupectví U Lípy</h1><h2>Kontakt</h2><p>Napište nám na info@knihy.example nebo volejte 777 123 456.</p><form><input name="email"></form><a href="/ochrana-osobnich-udaju.html">Ochrana osobních údajů</a><img src="/photo.png" alt="Prodejna"></main>',
    ),
    'site/ochrana-osobnich-udaju.html': page(
      'Ochrana osobních údajů – Knihkupectví U Lípy',
      head('ochrana-osobnich-udaju.html', 'Ochrana osobních údajů'),
      '<main><h1>Ochrana osobních údajů</h1><p>Jak zpracováváme osobní údaje.</p></main>',
    ),
    'site/404.html': page('Stránka nenalezena'),
    'site/sitemap.xml':
      '<urlset><url><loc>https://knihy.example/</loc></url><url><loc>https://knihy.example/ochrana-osobnich-udaju.html</loc></url></urlset>',
    'site/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://knihy.example/sitemap.xml\n',
    'site/favicon.ico': png(32, 32),
    'site/apple-touch-icon.png': png(180, 180),
    'site/share.png': png(1200, 630),
    'site/photo.png': png(400, 300),
  });
  const bare = await site({
    'site/index.html': page(
      'Web',
      '',
      '<main><h2>Vítejte</h2><h4>Novinky</h4><form><input name="email"></form><img src="/Photo.png" style="width:200px"><p style="color:#eee;background:#fff">Světlý text</p><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></main>',
      '',
    ),
    'site/O_nas.html': page('Web', '', '<main><h1>O nás</h1><h1>Tým</h1></main>', ''),
    'site/Photo.png': png(2000, 1500),
  });
  try {
    const good = await completenessChecks(complete.root, complete.files, { siteUrl: 'https://knihy.example/' }),
      poor = await completenessChecks(bare.root, bare.files, { siteUrl: 'https://knihy.example/' });
    const rules = Object.keys(status(good));
    assert.deepEqual(
      rules.filter((rule) => !status(good)[rule]),
      [],
      JSON.stringify(good.groups),
    );
    assert.deepEqual(
      rules.filter((rule) => status(poor)[rule]),
      [],
      JSON.stringify(poor.groups),
    );
    // The six groups of documentation 4.11, each rule once.
    assert.deepEqual(
      good.groups.map((g) => g.id),
      ['face', 'search', 'sharing', 'access', 'eu', 'function'],
    );
    // A warning names the pages it is about; the AI part is separate.
    const titles = poor.groups[0].items.find((i) => i.id === 'title')!;
    assert.deepEqual(titles.pages, ['site/O_nas.html']);
    assert.equal(good.ai.done, false);
    assert.equal(good.excerpt.length, 2);
  } finally {
    await rm(complete.root, { recursive: true, force: true });
    await rm(bare.root, { recursive: true, force: true });
  }
});
test('PU-16: the completeness result is kept per commit: the AI part runs once, the same commit is not checked or paid for again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completeness-cache-')),
    { Project } = await import('../src/project.ts'),
    { completenessFor } = await import('../src/completeness.ts');
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({ 'site/index.html': page('Kavárna', '', '<main><h1>Kavárna</h1><form></form></main>') });
    const commit = await project.commit('Fixture page');
    let calls = 0;
    const review = async (excerpt: any[]) => {
      calls++;
      assert.equal(excerpt[0].title, 'Kavárna');
      return {
        texts: { ok: false, detail: 'Název stránky je obecný.' },
        privacy: { ok: false, detail: 'Chybí informace o zpracování údajů.' },
      };
    };
    const first = await completenessFor(project, commit, join(root, 'data'), review),
      second = await completenessFor(project, commit, join(root, 'data'), review);
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    assert.equal(first.ai.done, true);
    const texts = first.groups.find((g) => g.id === 'face')!.items.find((i) => i.id === 'texts_fit')!;
    assert.deepEqual([texts.ok, texts.detail], [false, 'Název stránky je obecný.']);
    assert.ok(first.groups.find((g) => g.id === 'eu')!.items.some((i) => i.id === 'privacy_content' && !i.ok));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('PU-17: without an AI key, or when the provider fails, only the rules run and the result says the AI part was not done', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completeness-nokey-')),
    { Project } = await import('../src/project.ts'),
    { completenessFor } = await import('../src/completeness.ts');
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({ 'site/index.html': page('Kavárna') });
    const commit = await project.commit('Fixture page');
    const none = await completenessFor(project, commit, join(root, 'data'), null);
    assert.deepEqual(none.ai, { done: false, note: 'no_key' });
    assert.equal(none.groups.length, 6);
    let calls = 0;
    const failing = async () => {
      calls++;
      throw Error('provider down');
    };
    assert.deepEqual((await completenessFor(project, commit, join(root, 'data'), failing)).ai, {
      done: false,
      note: 'failed',
    });
    // A result without the AI part is not kept: the next check with a working key does the AI part.
    await completenessFor(project, commit, join(root, 'data'), failing);
    assert.equal(calls, 2);
    // An invalid answer of the model counts as a failure, never as a result.
    assert.equal(
      (await completenessFor(project, commit, join(root, 'data'), async () => ({ texts: 'fine' }))).ai.note,
      'failed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-38: Completeness check is a third check of a request, off by default; the request accepts it', async () => {
  const { requestChecks } = await import('../src/request-checks.ts');
  assert.deepEqual(requestChecks(undefined), { technical: true, verification: true, completeness: false });
  assert.equal(requestChecks({ technical: true, verification: false, completeness: true }).completeness, true);
  assert.throws(() => requestChecks({ completeness: 'yes' }));
  assert.throws(() => requestChecks({ seo: true }));
});
test('RE-06: Check external links too: a working link is ok, 404 is missing, no answer is unavailable, an internal address is never contacted', async () => {
  await import('../../../test/fixtures/redirect-to-internal.mjs');
  const { probePublic } = await import('../src/web-import.ts'),
    { checkExternalLinks } = await import('../src/completeness.ts');
  assert.equal(await probePublic('http://ok.example.test/'), 'ok');
  assert.equal(await probePublic('http://gone.example.test/page'), 'missing');
  assert.equal(await probePublic('http://nothing.invalid/', 3000), 'unavailable');
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://example.org:8080/',
    // A public address that redirects into the internal network.
    'http://redirect.example.test/',
  ])
    assert.equal(await probePublic(url), 'internal', url);
  // Every address once, in the order of the website, at most 100.
  const many = Array.from({ length: 120 }, (_, i) => 'https://site' + i + '.example/');
  const seen: string[] = [];
  const checked = await checkExternalLinks(
    many,
    async (url) => (seen.push(url), url.includes('site7.') ? 'missing' : 'ok'),
  );
  assert.equal(checked.length, 100);
  assert.equal(seen.length, 100);
  assert.deepEqual(checked[7], { url: 'https://site7.example/', state: 'missing' });
  assert.equal(checked[0].url, 'https://site0.example/');
});
