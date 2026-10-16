import http from 'node:http';
import { fieldCatalog } from '../../../cmstudio/field-catalog.ts';
// Importing this module gives a test the Content editor's field catalog: AI Studio reads it from
// SITETILLER_CMS_URL/api/field-catalog before any content-aware request. A URL set by the test itself wins.
if (!process.env.SITETILLER_CMS_URL) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/field-catalog') {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fieldCatalog));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  process.env.SITETILLER_CMS_URL = 'http://127.0.0.1:' + (server.address() as any).port;
}
