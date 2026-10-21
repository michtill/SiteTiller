// The hosting's live website for the controller (Publisher /snapshot): an invented public website, so loading the
// live website works without network access.
const original = globalThis.fetch;
const page =
  '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Živý web</title></head><body><main><h1>Živý web z hostingu</h1></main></body></html>';
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/snapshot'))
    return Promise.resolve(
      Response.json({
        files: { 'site/index.html': page },
        binary: {},
        evidence: {
          url: 'https://web.example.test/',
          source: 'hosting',
          resources: [{ path: 'site/index.html', url: 'https://web.example.test/' }],
          warnings: [],
          limitations: [],
        },
      }),
    );
  return original(input, options);
};
