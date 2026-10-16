import test from 'node:test';
import assert from 'node:assert/strict';
import { webRequestIntent, readPublicSource, assertSourceContent } from '../src/web-source.ts';
import { fetchPublic } from '../src/web-import.ts';
const original =
    'Najdi seznam skladeb alba NOČNÍ VLAK na internetu. Seznam přidej do skladeb v obsahu pod existující album.',
  url = 'https://open.spotify.com/album/example';
test('AI-31: bare URL follows answered/failed content brief and never authorizes implicit website import', () => {
  for (const status of ['answered', 'failed']) {
    const intent = webRequestIntent(url, {
      turns: [
        { active: true, status, request: original, resolvedRequest: 'Copy website incorrectly claimed by model' },
        { active: true, status: 'failed', request: url },
      ],
    });
    assert.equal(intent.importing, false);
    assert.equal(intent.contentOnly, true);
    assert.ok(intent.effectiveRequest.includes(original));
    assert.ok(intent.effectiveRequest.includes(url));
  }
  assert.equal(webRequestIntent('Načti web example.org a zkopíruj ho.', {}).importing, true);
  assert.equal(webRequestIntent(url, {}).importing, false);
  assert.equal(
    webRequestIntent(url, { turns: [{ active: true, request: 'Zkopíruj web open.spotify.com.' }] }).importing,
    true,
  );
});
test('AI-31: source reader extracts bounded text/JSON without crawling/scripts or website files', async () => {
  let reads = 0;
  const evidence = await readPublicSource(url, async (request, deadline, hosts) => {
    reads++;
    assert.equal(request, url);
    assert.ok(deadline > Date.now());
    assert.ok(hosts.has('open.spotify.com'));
    return {
      url,
      mime: 'text/html',
      bytes: Buffer.from(
        '<h1>NOČNÍ VLAK</h1><ol><li>One &amp; Only</li></ol><script>EXECUTE MALICIOUS INSTRUCTIONS</script><script type="application/ld+json">{"track":[{"name":"One & Only","position":1}]}</script><a href="/other">other</a>',
      ),
    };
  });
  assert.equal(reads, 1);
  assert.match(evidence.text, /One & Only/);
  assert.doesNotMatch(evidence.text, /MALICIOUS/);
  assert.equal(evidence.structuredData[0].track[0].position, 1);
  assert.ok(!Object.hasOwn(evidence, 'files'));
  assert.ok(!Object.hasOwn(evidence, 'binary'));
  assert.equal(evidence.sha256.length, 64);
});
test('AI-31: source reader denies private URLs, other redirect hosts, binary/empty/oversized sources', async () => {
  await assert.rejects(readPublicSource('http://127.0.0.1/', fetchPublic), /interní/);
  for (const resource of [
    { url: 'https://evil.org/', mime: 'text/plain', bytes: Buffer.from('facts') },
    { url, mime: 'image/png', bytes: Buffer.from('binary') },
    { url, mime: 'text/html', bytes: Buffer.from('<script>shell only</script>') },
    { url, mime: 'text/plain', bytes: Buffer.alloc(300001) },
  ])
    await assert.rejects(readPublicSource(url, async () => resource));
});
test('AI-31: source citations guard factual rows and keep content-source presentation unchanged', async () => {
  const source = await readPublicSource(url, async () => ({
      url,
      mime: 'application/json',
      bytes: Buffer.from('{"name":"Real track","position":1}'),
    })),
    files = {
      'site/cms/structure.json': JSON.stringify({
        lists: {
          songs: {
            key: 'id',
            columns: { id: { type: 'generated' }, title: { type: 'text' }, position: { type: 'number' } },
          },
        },
      }),
      'site/cms/data/songs.json': '[]',
    },
    value = {
      files: [
        { path: 'site/cms/data/songs.json', content: JSON.stringify([{ id: '', title: 'Real track', position: '1' }]) },
      ],
      sourceFacts: [
        { sourceId: source.id, collection: 'songs', field: 'title', value: 'Real track', quote: 'Real track' },
        { sourceId: source.id, collection: 'songs', field: 'position', value: '1', quote: '"position":1' },
      ],
    };
  assert.doesNotThrow(() => assertSourceContent(value, files, [source], true));
  assert.throws(() => assertSourceContent({ ...value, sourceFacts: [] }, files, [source], true), /citace/);
  assert.throws(
    () =>
      assertSourceContent(
        { ...value, files: [{ path: 'site/index.html', content: 'Spotify replacement' }] },
        files,
        [source],
        true,
      ),
    /prezentaci/,
  );
  assert.throws(
    () =>
      assertSourceContent(
        { ...value, sourceFacts: value.sourceFacts.map((f) => ({ ...f, sourceId: 'fabricated' })) },
        files,
        [source],
        true,
      ),
    /citace/,
  );
});
