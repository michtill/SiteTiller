// Invented public album page and agent proposals for source-order scenarios (AI-31, AI-32).
// The page lists track titles in order without numbers; the header states the track count.
export const titles = ['Ranní mlha', 'Skleník', 'Most přes řeku', '?Smysl?', 'Left & Rights'];
export const artist = 'Ukázková kapela';
export const albumCode = '001-DEMO';
export const sourceUrl = 'https://music.example.test/album/demo';
const sequence = titles.map((title) => title + ' · ' + artist).join(' ');
const header = 'Demo album · ' + artist + ' · ' + titles.length + ' skladeb';
export function source(id = 'source-demo') {
  return {
    id,
    requestedUrl: sourceUrl,
    url: sourceUrl,
    mime: 'text/html',
    text: header + ' ' + sequence + ' Další od interpreta ' + artist,
    structuredData: [{ '@type': 'MusicAlbum', name: 'Demo album', numTracks: titles.length }],
  };
}
export const tracksDefinition = {
  label: 'Skladby',
  key: 'code',
  display: 'title',
  group: ['album_code'],
  columns: {
    title: { type: 'text', label: 'Název skladby', required: true },
    code: { type: 'text', label: 'Kód skladby', required: true },
    album_code: { type: 'list', label: 'Album', required: true, list: 'albums' },
    position: { type: 'number', label: 'Pořadí skladby na albu' },
  },
};
const rows = () =>
  titles.map((title, i) => ({
    code: albumCode + '-' + String(i + 1).padStart(2, '0'),
    title,
    album_code: albumCode,
    position: String(i + 1),
  }));
const proposal = (sourceFacts: any[]) => ({
  action: 'implement',
  scope: 'edit',
  files: [{ path: 'site/cms/data/tracks.json', content: JSON.stringify(rows()) }],
  sourceFacts,
});
const fact = (sourceId: string, field: string, value: string, quote: string) => ({
  sourceId,
  collection: 'tracks',
  field,
  value,
  quote,
});
// One fact for the whole title list and one for the derived order.
export const listProposal = (sourceId = 'source-demo') =>
  proposal([
    fact(sourceId, 'title', titles.join('; '), sequence),
    fact(sourceId, 'position', '1–' + titles.length + ', podle pořadí ve zdroji', sequence),
  ]);
// Titles only: the order is written but not proven.
export const titlesOnlyProposal = (sourceId = 'source-demo') =>
  proposal(titles.map((title) => fact(sourceId, 'title', title, title + ' · ' + artist)));
// Each position quotes the sequence up to its track; the first quote also includes the header count.
export const prefixProposal = (sourceId = 'source-demo') =>
  proposal([
    ...titles.map((title) => fact(sourceId, 'title', title, title + ' · ' + artist)),
    ...titles.map((_, i) =>
      fact(
        sourceId,
        'position',
        String(i + 1),
        (i === 0 ? header + ' ' : '') +
          titles
            .slice(0, i + 1)
            .map((t) => t + ' · ' + artist)
            .join(' '),
      ),
    ),
  ]);
export const request = 'Přidej skladby z alba ' + sourceUrl + ' do alba Demo album s kódem ' + albumCode;
