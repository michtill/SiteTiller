import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHostingPolicy, hostingPolicyProbeUrl, hostingPolicyPath } from '../src/hosting-policy-probe.ts';
import { runtimeRootPolicy, serveHostingPolicy } from '../src/hosting-policy-endpoint.ts';
import { productionPolicy } from '../src/site-policy.ts';
import { websiteServer } from '../src/website-server.ts';
test('PU-04: default URL and same-origin fixed endpoint use HEAD/no-store/no redirects with unchanged CSP checks', async () => {
  for (const configured of [undefined, 'https://production.test' + hostingPolicyPath]) {
    let called = 0;
    await assertHostingPolicy('https://production.test/legacy/', configured, async (url, options) => {
      called++;
      assert.equal(String(url), configured || 'https://production.test/legacy/');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal);
      return new Response(null, { headers: { 'Content-Security-Policy': productionPolicy } });
    });
    assert.equal(called, 1);
  }
  for (const header of [null, "default-src 'none'", productionPolicy + ", default-src 'none'"]) {
    await assert.rejects(
      assertHostingPolicy(
        'https://production.test/',
        'https://production.test' + hostingPolicyPath,
        async () => new Response(null, { headers: header ? { 'Content-Security-Policy': header } : {} }),
      ),
      /CSP/,
    );
  }
});
test('PU-04: invalid explicit origin/protocol/port/path/credentials/query/fragment rejects before any request', async () => {
  for (const value of [
    'https://other.test' + hostingPolicyPath,
    'http://production.test' + hostingPolicyPath,
    'https://production.test:444' + hostingPolicyPath,
    'https://user:secret@production.test' + hostingPolicyPath,
    'https://@production.test' + hostingPolicyPath,
    'https://production.test/other',
    'https://production.test/../' + hostingPolicyPath.slice(1),
    'https://production.test/.well-known/%73itetiller-hosting-policy',
    'https://production.test' + hostingPolicyPath + '?',
    'https://production.test' + hostingPolicyPath + '?url=http://127.0.0.1/',
    'https://production.test' + hostingPolicyPath + '#',
    'file:///tmp/policy',
  ])
    await assert.rejects(
      assertHostingPolicy('https://production.test/', value, async () => {
        throw Error('Must not fetch invalid target');
      }),
      /Invalid fixed/,
    );
  assert.equal(
    hostingPolicyProbeUrl('http://127.0.0.1:4512/', 'http://127.0.0.1:4512' + hostingPolicyPath).pathname,
    hostingPolicyPath,
  );
});
test('PU-04: redirect never reaches its destination', async () => {
  let destination = 0;
  const server = http.createServer((req, res) => {
    if (req.url === hostingPolicyPath) {
      res.writeHead(302, { Location: '/other' });
      res.end();
    } else {
      destination++;
      res.setHeader('Content-Security-Policy', productionPolicy);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    await assert.rejects(assertHostingPolicy(origin + '/', origin + hostingPolicyPath));
    assert.equal(destination, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('PU-04: preflight has exact ten-second abort deadline and no retry fallback', async () => {
  const original = AbortSignal.timeout;
  let requests = 0;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 10000);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException('Fixture timeout', 'TimeoutError')));
      return controller.signal;
    };
    await assert.rejects(
      assertHostingPolicy('https://production.test/', undefined, async (_url, options) => {
        requests++;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }),
      { name: 'TimeoutError' },
    );
    assert.equal(requests, 1);
  } finally {
    AbortSignal.timeout = original;
  }
});
test('PU-04: website endpoint probes fixed runtime root and returns only CSP/status/no-store, HEAD-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-host-policy-')),
    server = websiteServer(root, 'http://127.0.0.1');
  try {
    await writeFile(join(root, 'index.html'), 'Prepared target body must not be returned');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port,
      response = await fetch(origin + hostingPolicyPath, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Security-Policy'), productionPolicy);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Content-Type'), null);
    assert.equal(response.headers.get('X-Content-Type-Options'), null);
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      const rejected = await fetch(origin + hostingPolicyPath, { method });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('Allow'), 'HEAD');
      assert.equal(rejected.headers.get('Cache-Control'), 'no-store');
      assert.equal(await rejected.text(), '');
    }
    assert.equal((await fetch(origin + hostingPolicyPath + '?target=/private', { method: 'HEAD' })).status, 400);
    assert.equal((await fetch(origin + '/.env')).status, 404);
    const missing = websiteServer(join(root, 'missing'), 'http://127.0.0.1');
    await new Promise((resolve) => missing.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(
        (await fetch('http://127.0.0.1:' + missing.address().port + hostingPolicyPath, { method: 'HEAD' })).status,
        404,
      );
    } finally {
      await new Promise((resolve) => missing.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
test('PU-04: endpoint strips root contents/cookies/location and preserves missing/restrictive headers', async () => {
  for (const header of [null, "default-src 'none'"]) {
    const root = await runtimeRootPolicy(async (req, res) => {
      assert.equal(req.method, 'HEAD');
      assert.equal(req.url, '/');
      assert.equal(req.headers.host, 'production.test');
      res.setHeader('Set-Cookie', 'private');
      res.setHeader('Location', 'https://other.test');
      if (header) res.setHeader('Content-Security-Policy', header);
      res.writeHead(200);
      res.end('private body');
    }, 'https://production.test');
    assert.deepEqual(root, { status: 200, contentSecurityPolicy: header });
  }
});
test('PU-04: endpoint timeout returns502/no-store without contents or fabricated CSP', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const headers = {},
    res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(values || {})) this.setHeader(key, value);
      },
      end(body) {
        assert.equal(body, undefined);
      },
    },
    work = serveHostingPolicy({ method: 'HEAD', url: hostingPolicyPath }, res, () => new Promise(() => {}));
  t.mock.timers.tick(10000);
  await work;
  assert.equal(res.statusCode, 502);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['content-security-policy'], undefined);
});
