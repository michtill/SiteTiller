import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTextEdits } from '../src/text-edits.ts';
const edit = (before, after, path = 'site/a.txt') => ({ kind: 'replace', path, before, after });
test('AI-17: extract >50kB preserves UTF8 bytes, CRLF and literal dollars; sequential current candidate edits', () => {
  const code = 'const Czech="Žluťoučký 🦊 $&";\r\n' + '/* original calculation */\r\n'.repeat(2600),
    files = { 'site/index.html': '<style>body{color:red}</style><script>' + code + '</script>' },
    before = structuredClone(files);
  assert.ok(Buffer.byteLength(code) > 50000);
  const expanded = expandTextEdits(
    {
      files: [],
      textEdits: [
        {
          kind: 'extract',
          path: 'site/index.html',
          start: '<script>',
          end: '</script>',
          target: 'site/app.js',
          replacement: '<script src="app.js"></script>',
        },
        edit('color:red', 'color:blue', 'site/index.html'),
        edit('color:blue', 'color:$&', 'site/index.html'),
      ],
    },
    files,
    new Set(Object.keys(files)),
  );
  assert.deepEqual(Buffer.from(expanded.find((f) => f.path === 'site/app.js').content), Buffer.from(code));
  assert.equal(
    expanded.find((f) => f.path === 'site/index.html').content,
    '<style>body{color:$&}</style><script src="app.js"></script>',
  );
  assert.deepEqual(files, before);
});
test('AI-17: unique, ambiguous including overlaps, stale and unread matches', () => {
  for (const [text, operation, observed] of [
    ['xx', edit('x', 'y'), ['site/a.txt']],
    ['aaa', edit('aa', 'y'), ['site/a.txt']],
    ['old', edit('stale', 'y'), ['site/a.txt']],
    ['old', edit('old', 'y'), []],
  ]) {
    const files = { 'site/a.txt': text };
    assert.throws(() => expandTextEdits({ textEdits: [operation] }, files, new Set(observed)));
    assert.equal(files['site/a.txt'], text);
  }
  assert.equal(
    expandTextEdits({ textEdits: [edit('old', '$&')] }, { 'site/a.txt': 'old' }, new Set(['site/a.txt']))[0].content,
    '$&',
  );
});
test('AI-17: invalid later operation rejects whole batch without mutating inputs', () => {
  const files = { 'site/a.txt': 'old' },
    value = { files: [], textEdits: [edit('old', 'first'), edit('stale', 'second')] },
    initial = structuredClone(value);
  assert.throws(() => expandTextEdits(value, files, new Set(['site/a.txt'])));
  assert.deepEqual(files, { 'site/a.txt': 'old' });
  assert.deepEqual(value, initial);
});
test('AI-17: extraction markers must both be globally unique and properly ordered', () => {
  for (const text of ['<s>a</s><s>b</s>', '</s><s>a</s>', '<s>a</s></s>', '<s>no end'])
    assert.throws(() =>
      expandTextEdits(
        {
          textEdits: [
            { kind: 'extract', path: 'site/a.txt', start: '<s>', end: '</s>', target: 'site/new.txt', replacement: '' },
          ],
        },
        { 'site/a.txt': text },
        new Set(['site/a.txt']),
      ),
    );
});
test('AI-17: full-file/deletion conflicts and existing or duplicate extraction targets rejected', () => {
  const extract = {
      kind: 'extract',
      path: 'site/a.txt',
      start: '<s>',
      end: '</s>',
      target: 'site/new.txt',
      replacement: '',
    },
    files = { 'site/a.txt': '<s>text</s>other' };
  for (const value of [
    { files: [{ path: 'site/a.txt', content: 'whole' }], textEdits: [extract] },
    { files: [{ path: 'site/new.txt', content: 'whole' }], textEdits: [extract] },
    { deleteFiles: ['site/a.txt'], textEdits: [extract] },
    { deleteFiles: ['site/new.txt'], textEdits: [extract] },
    { textEdits: [extract, { ...extract, path: 'site/b.txt' }] },
  ])
    assert.throws(() =>
      expandTextEdits(value, { ...files, 'site/b.txt': '<s>second</s>' }, new Set(['site/a.txt', 'site/b.txt'])),
    );
  assert.throws(() =>
    expandTextEdits({ textEdits: [extract] }, { ...files, 'site/new.txt': '' }, new Set(['site/a.txt'])),
  );
});
test('AI-17: malformed or oversized operation batches rejected', () => {
  for (const textEdits of [
    null,
    {},
    '',
    Array(41).fill(edit('old', 'new')),
    [{ kind: 'shell', path: 'site/a.txt' }],
    [edit('', 'new')],
  ])
    assert.throws(() => expandTextEdits({ textEdits }, { 'site/a.txt': 'old' }, new Set(['site/a.txt'])));
});
