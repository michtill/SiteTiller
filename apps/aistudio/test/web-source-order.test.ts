import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSourceContent, prepareSourceContent, webRequestIntent } from '../src/web-source.ts';
import {
  source,
  tracksDefinition,
  listProposal,
  titlesOnlyProposal,
  prefixProposal,
  titles,
  albumCode,
} from './fixtures/source-order.ts';
const sources = () => {
  const s = source();
  return [{ ...s, citationText: s.text + '\n' + JSON.stringify(s.structuredData) }];
};
const files = () => ({
  'site/cms/structure.json': JSON.stringify({
    lists: {
      tracks: tracksDefinition,
      albums: { key: 'code', columns: { code: { type: 'text' }, title: { type: 'text' } } },
    },
  }),
  'site/cms/data/albums.json': JSON.stringify([{ code: albumCode, title: 'Demo album' }]),
  'site/cms/data/tracks.json': '[]',
});
test('AI-31: order follows from the complete unique title sequence, not from a number in the source', () => {
  assert.doesNotThrow(() => assertSourceContent(listProposal(), files(), sources(), true));
  assert.doesNotThrow(() => assertSourceContent(prefixProposal(), files(), sources(), true));
  // Titles alone establish the order only when the source also declares the track count.
  assert.doesNotThrow(() => assertSourceContent(titlesOnlyProposal(), files(), sources(), true));
  const undeclared = sources();
  undeclared[0].structuredData = [{ '@type': 'MusicAlbum', name: 'Demo album' }];
  undeclared[0].citationText = undeclared[0].text + '\n' + JSON.stringify(undeclared[0].structuredData);
  assert.throws(() => assertSourceContent(titlesOnlyProposal(), files(), undeclared, true), /tracks.position/);
});
test('AI-31: swapped/wrong/header-total order and invented titles are rejected; partial or ambiguous list cannot infer ordinals', () => {
  const base = prefixProposal();
  for (const mutation of [
    (p) => {
      const rows = JSON.parse(p.files[0].content);
      rows[0].position = String(titles.length);
      p.files[0].content = JSON.stringify(rows);
      p.sourceFacts.push({
        sourceId: 'source-demo',
        collection: 'tracks',
        field: 'position',
        value: String(titles.length),
        quote: titles.length + ' skladeb',
      });
    },
    (p) => {
      const rows = JSON.parse(p.files[0].content);
      [rows[0].position, rows[1].position] = [rows[1].position, rows[0].position];
      p.files[0].content = JSON.stringify(rows);
    },
    (p) => {
      const rows = JSON.parse(p.files[0].content);
      rows[0].title = 'Invented track';
      p.files[0].content = JSON.stringify(rows);
    },
    (p) => {
      const rows = JSON.parse(p.files[0].content);
      rows.shift();
      p.files[0].content = JSON.stringify(rows);
    },
    (p) => {
      p.sourceFacts = p.sourceFacts.filter((f) => !(f.field === 'title' && f.value === titles[1]));
    },
  ]) {
    const changed = structuredClone(base);
    mutation(changed);
    assert.throws(() => assertSourceContent(changed, files(), sources(), true), /citace/);
  }
  const ambiguous = sources();
  ambiguous[0].text += ' ' + titles[1];
  ambiguous[0].citationText = ambiguous[0].text + '\n' + JSON.stringify(ambiguous[0].structuredData);
  assert.throws(() => assertSourceContent(base, files(), ambiguous, true), /citace/);
});
test('AI-31: structured number uses same item identity and semantic numeric value; unrelated item or arbitrary number cannot prove order', () => {
  const source = {
      id: 'structured',
      text: '',
      structuredData: [
        {
          track: [
            { name: 'First', position: 1 },
            { name: 'Second', position: 2 },
          ],
        },
      ],
      citationText:
        '\n' +
        JSON.stringify([
          {
            track: [
              { name: 'First', position: 1 },
              { name: 'Second', position: 2 },
            ],
          },
        ]),
    },
    schema = {
      lists: {
        tracks: {
          key: 'code',
          display: 'title',
          columns: {
            code: { type: 'text' },
            title: { type: 'text' },
            position: { type: 'number', label: 'Position' },
            price: { type: 'number', label: 'Price' },
          },
        },
      },
    },
    before = { 'site/cms/structure.json': JSON.stringify(schema), 'site/cms/data/tracks.json': '[]' },
    proposal = {
      files: [{ path: 'site/cms/data/tracks.json', content: '[{"code":"new","title":"First","position":"1.0"}]' }],
      sourceFacts: [
        { sourceId: 'structured', collection: 'tracks', field: 'title', value: 'First', quote: 'First' },
        { sourceId: 'structured', collection: 'tracks', field: 'position', value: '1.0', quote: '"position": 1' },
      ],
    };
  assert.doesNotThrow(() => assertSourceContent(proposal, before, [source], true));
  const wrong = structuredClone(proposal);
  wrong.files[0].content = '[{"code":"new","title":"First","position":"2"}]';
  wrong.sourceFacts[1] = { ...wrong.sourceFacts[1], value: '2', quote: '"position":2' };
  assert.throws(() => assertSourceContent(wrong, before, [source], true), /citace/);
  const fabricated = structuredClone(proposal);
  fabricated.files[0].content = '[{"code":"new","title":"First","position":"1","price":"987"}]';
  fabricated.sourceFacts[1] = { ...fabricated.sourceFacts[1], value: '1' };
  assert.throws(() => assertSourceContent(fabricated, before, [source], true), /price/);
});
test('AI-22: retry keeps latest substantive failed content intent and source/import restrictions', () => {
  const brief = 'Přidej skladby z alba https://music.example.test/album/example do alba Demo album';
  const intent = webRequestIntent('znovu', {
    turns: [
      { active: true, status: 'answered', request: brief },
      { active: true, status: 'failed', request: 'https://music.example.test/album/example' },
      { active: true, status: 'failed', request: 'znovu' },
    ],
  });
  assert.equal(intent.contentOnly, true);
  assert.equal(intent.importing, false);
  assert.ok(intent.effectiveRequest.includes(brief));
});

test('AI-32: optional unsupported order becomes blank review; authored and explicitly confirmed choices remain user-controlled', () => {
  const before = files(),
    source = sources(),
    proposal = prefixProposal(),
    rows = JSON.parse(proposal.files[0].content);
  rows[0].position = '99';
  proposal.files[0].content = JSON.stringify(rows);
  const reviews = prepareSourceContent(proposal, before, source, true, '');
  assert.equal(JSON.parse(proposal.files[0].content)[0].position, '');
  assert.ok(reviews.some((review) => review.status === 'blank'));
  const authored = prefixProposal(),
    custom = JSON.parse(authored.files[0].content);
  custom[0].position = '99';
  authored.files[0].content = JSON.stringify(custom);
  authored.sourceFacts.push({
    basis: 'user',
    collection: 'tracks',
    field: 'position',
    value: '99',
    quote: titles[0] + ' pořadí 99',
  });
  assert.doesNotThrow(() => prepareSourceContent(authored, before, source, true, titles[0] + ' pořadí 99'));
  assert.equal(JSON.parse(authored.files[0].content)[0].position, '99');
  const unverified = prefixProposal(),
    candidate = JSON.parse(unverified.files[0].content);
  candidate[0].title = 'My authored track';
  unverified.files[0].content = JSON.stringify(candidate);
  const choices = prepareSourceContent(unverified, before, source, true, '');
  assert.ok(choices.some((choice) => choice.status === 'decision' && choice.value === 'My authored track'));
  const intent = webRequestIntent('ano', {
    turns: [
      {
        active: true,
        status: 'answered',
        request: 'Add tracks',
        sourceDecisions: [{ collection: 'tracks', field: 'title', value: 'My authored track' }],
      },
    ],
  });
  const confirmed = prepareSourceContent(unverified, before, source, true, intent.userContext, intent.confirmedChoices);
  assert.ok(!confirmed.some((choice) => choice.status === 'decision'));
});
