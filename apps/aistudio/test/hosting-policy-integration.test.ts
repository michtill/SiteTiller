import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stopOwnedChild } from '../../../scripts/processes.mjs';
import { Project } from '../src/project.ts';
import { websiteServer } from '../src/website-server.ts';
import { assertHostingPolicy, hostingPolicyPath } from '../src/hosting-policy-probe.ts';
import { productionPolicy } from '../src/site-policy.ts';
const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port))),
  close = (server) => new Promise((resolve) => server.close(resolve));
async function freePort() {
  const server = http.createServer(),
    origin = await listen(server);
  await close(server);
  return Number(new URL(origin).port);
}
async function ready(url, expected) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url, { redirect: 'manual' })).status === expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Fixture service not ready');
}
async function digest(root) {
  const entries = [];
  async function walk(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
      else
        entries.push([
          name,
          createHash('sha256')
            .update(await readFile(join(path, entry.name)))
            .digest('hex'),
        ]);
    }
  }
  await walk(root);
  return JSON.stringify(entries.sort());
}
test(
  'PU-04: pre-first-publication wrapper probes fixed prepared target while public root remains503; absent/unready target blocks',
  { timeout: 60000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'example-first-policy-')),
      root = join(base, 'production'),
      prepared = join(base, 'prepared');
    let child;
    try {
      await mkdir(root);
      await mkdir(prepared);
      await writeFile(join(prepared, 'index.html'), 'Prepared unpublished target');
      const before = await digest(base),
        port = await freePort(),
        origin = 'http://127.0.0.1:' + port,
        env = {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          SITETILLER_SITE_ORIGIN: origin,
          SITETILLER_LOCAL_PRODUCTION_ROOT: root,
          SITETILLER_HOSTING_POLICY_DIRECTORY: prepared,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        };
      child = spawn(process.execPath, [fileURLToPath(new URL('../../website/server.ts', import.meta.url))], {
        env,
        windowsHide: true,
        stdio: 'ignore',
      });
      await ready(origin + '/', 503);
      const legacy = await (await fetch(origin + '/')).text();
      await assert.rejects(assertHostingPolicy(origin + '/'), /unavailable/);
      await assertHostingPolicy(origin + '/', origin + hostingPolicyPath);
      const policy = await fetch(origin + hostingPolicyPath, { method: 'HEAD' });
      assert.equal(policy.status, 200);
      assert.equal(policy.headers.get('Content-Security-Policy'), productionPolicy);
      assert.equal(policy.headers.get('Cache-Control'), 'no-store');
      assert.equal(await policy.text(), '');
      for (const method of ['GET', 'POST'])
        assert.equal((await fetch(origin + hostingPolicyPath, { method })).status, 405);
      assert.equal((await fetch(origin + hostingPolicyPath + '?directory=/private', { method: 'HEAD' })).status, 400);
      assert.equal((await fetch(origin + '/')).status, 503);
      assert.equal(await (await fetch(origin + '/')).text(), legacy);
      assert.equal(await digest(base), before);
      await stopOwnedChild(child);
      child = null;
      await rm(join(prepared, 'index.html'));
      child = spawn(process.execPath, [fileURLToPath(new URL('../../website/server.ts', import.meta.url))], {
        env,
        windowsHide: true,
        stdio: 'ignore',
      });
      await ready(origin + '/', 503);
      await assert.rejects(assertHostingPolicy(origin + '/', origin + hostingPolicyPath), /unavailable/);
      assert.equal((await fetch(origin + hostingPolicyPath, { method: 'HEAD' })).status, 404);
      await stopOwnedChild(child);
      child = null;
      child = spawn(process.execPath, [fileURLToPath(new URL('../../website/server.ts', import.meta.url))], {
        env: { ...env, SITETILLER_HOSTING_POLICY_DIRECTORY: '' },
        windowsHide: true,
        stdio: 'ignore',
      });
      await ready(origin + '/', 503);
      assert.equal((await fetch(origin + hostingPolicyPath, { method: 'HEAD' })).status, 503);
      await assert.rejects(readFile(join(root, 'current.json')), { code: 'ENOENT' });
    } finally {
      if (child) await stopOwnedChild(child);
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
test(
  'PU-04: publisher checks externally effective target CSP before any production writes; operator override only and idle status protected',
  { timeout: 240000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'example-policy-write-gate-')),
      data = join(base, 'studio'),
      target = join(base, 'prepared'),
      production = join(base, 'production.git');
    await mkdir(data);
    await mkdir(target);
    await writeFile(join(target, 'index.html'), 'Prepared target');
    const work = new Project(join(data, 'project'));
    await work.init(null);
    const before = await work.head();
    await work.write({ 'site/style.css': 'body{color:blue}' });
    const candidate = await work.commit('Candidate');
    await writeFile(
      join(data, 'publish-approval.json'),
      JSON.stringify({ commit: candidate, head: candidate, intent: null }),
    );
    await work.git(['clone', '--bare', work.root, production]);
    const remote = new Project(production);
    await remote.git(['update-ref', 'refs/heads/main', before]);
    const original = await digest(production),
      draft = await work.head(),
      children = [];
    let mode = 'missing',
      rootHits = 0,
      policyHits = 0,
      release,
      entered;
    const enteredPolicy = new Promise((resolve) => (entered = resolve)),
      started = Date.now(),
      progress = (message) =>
        console.log('Publisher fixture: ' + message + ' (' + Math.round((Date.now() - started) / 1000) + 's)');
    const prepared = websiteServer(target, 'http://127.0.0.1'),
      preparedOrigin = await listen(prepared),
      proxy = http.createServer(async (req, res) => {
        if (req.url === hostingPolicyPath) {
          policyHits++;
          if (mode === 'redirect') {
            res.writeHead(302, { Location: '/redirected' });
            return res.end();
          }
          if (mode === 'hold') {
            entered();
            await new Promise((resolve) => {
              release = resolve;
              req.once('aborted', resolve);
              res.once('close', resolve);
            });
          }
          const upstream = await fetch(preparedOrigin + hostingPolicyPath, { method: 'HEAD', redirect: 'error' }),
            headers = { 'Cache-Control': 'no-store' };
          if (mode !== 'missing')
            headers['Content-Security-Policy'] =
              mode === 'valid'
                ? upstream.headers.get('Content-Security-Policy')
                : productionPolicy + ", default-src 'none'";
          res.writeHead(upstream.status, headers);
          res.end();
        } else {
          rootHits++;
          res.end('Legacy public website without CSP');
        }
      }),
      origin = await listen(proxy);
    async function start(probe, productionUrl = origin + '/', git = production) {
      const port = await freePort(),
        url = 'http://127.0.0.1:' + port,
        child = spawn(process.execPath, [fileURLToPath(new URL('../src/publisher.ts', import.meta.url))], {
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            SITETILLER_DATA_DIR: data,
            SITETILLER_PRODUCTION_GIT: git,
            SITETILLER_PUBLISH_TOKEN: 'fixture-token',
            SITETILLER_PRODUCTION_URL: productionUrl,
            SITETILLER_HOSTING_POLICY_URL: probe || '',
            SITETILLER_PRODUCTION_DIRECTORY: '',
            OPENAI_API_KEY: '',
            ANTHROPIC_API_KEY: '',
          },
          windowsHide: true,
          stdio: 'ignore',
        });
      children.push(child);
      await ready(url + '/publish', 401);
      return { url, child };
    }
    const status = async (worker) => {
        const unauthorized = await fetch(worker.url + '/status');
        assert.equal(unauthorized.status, 401);
        return await (
          await fetch(worker.url + '/status', { headers: { Authorization: 'Bearer fixture-token' } })
        ).json();
      },
      publish = async (worker, extra = {}) => {
        const response = await fetch(worker.url + '/publish', {
          method: 'POST',
          headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ commit: candidate, ...extra }),
        });
        return { status: response.status, value: await response.json() };
      };
    try {
      progress('default probe');
      const ordinary = await start();
      assert.equal((await status(ordinary)).hostingPolicyOverride, false);
      let result = await publish(ordinary, { hostingPolicyUrl: origin + hostingPolicyPath });
      assert.equal(result.status, 502);
      assert.match(result.value.error, /CSP/);
      assert.equal(policyHits, 0);
      assert.ok(rootHits > 0);
      assert.equal(await digest(production), original);
      await stopOwnedChild(ordinary.child);
      progress('fixed probe missing/restrictive/redirect');
      const fixed = await start(origin + hostingPolicyPath);
      assert.equal((await status(fixed)).hostingPolicyOverride, true);
      for (const failure of ['missing', 'restrictive', 'redirect']) {
        mode = failure;
        result = await publish(fixed);
        assert.equal(result.status, 502);
        assert.match(result.value.error, /CSP/);
        assert.equal(await digest(production), original);
        assert.equal(await work.head(), draft);
      }
      progress('idle status while policy pending');
      mode = 'hold';
      const pending = publish(fixed);
      let enteredTimer;
      try {
        await Promise.race([
          enteredPolicy,
          pending.then(() => {
            throw Error('Publication ended before held policy stage');
          }),
          new Promise((_, reject) => {
            enteredTimer = setTimeout(() => reject(Error('Policy stage was not reached')), 60000);
          }),
        ]);
      } finally {
        clearTimeout(enteredTimer);
      }
      assert.ok(release);
      assert.equal((await status(fixed)).busy, true);
      assert.equal(await digest(production), original);
      mode = 'restrictive';
      release();
      await pending;
      assert.equal((await status(fixed)).busy, false);
      await stopOwnedChild(fixed.child);
      mode = 'valid';
      progress('invalid operator path');
      const invalid = await start(origin + '/not-policy');
      const hits = policyHits;
      result = await publish(invalid);
      assert.equal(result.status, 502);
      assert.match(result.value.error, /CSP/);
      assert.equal(policyHits, hits);
      assert.equal(await digest(production), original);
      await stopOwnedChild(invalid.child);
      progress('missing production URL');
      const missingProduction = await start(origin + hostingPolicyPath, '');
      result = await publish(missingProduction);
      assert.equal(result.status, 502);
      assert.equal(await digest(production), original);
      await stopOwnedChild(missingProduction.child);
      progress('compatible target reaches Git stage');
      const successGate = await start(
        origin + hostingPolicyPath,
        origin + '/',
        join(base, 'nonexistent-fixed-production.git'),
      );
      result = await publish(successGate);
      assert.equal(result.status, 502);
      assert.match(result.value.error, /Zápis do produkčního Gitu selhal/);
      assert.ok(policyHits > hits);
      assert.equal(await digest(production), original);
      assert.equal(await work.head(), draft);
      assert.equal(await (await fetch(origin + '/')).text(), 'Legacy public website without CSP');
    } finally {
      if (release) release();
      for (const child of children) if (child.exitCode === null) await stopOwnedChild(child);
      await close(proxy);
      await close(prepared);
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
