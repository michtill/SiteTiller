import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Project } from '../src/project.ts';
import { saveNamedDraft } from '../src/saved-drafts.ts';
import { passwordHash } from '../../../packages/settings/index.mjs';
import { initialTeam, initialImages } from '../src/team.ts';
import { issueSnapshotAccess, validSnapshotAccess } from '../src/snapshot-access.ts';
test('HI-11: snapshot credentials bind id+commit, reject tampering/other snapshots/expiry', () => {
  const secret = Buffer.from('fixture-secret'),
    a = issueSnapshotAccess(secret, 'draft-one', 'a'.repeat(40));
  assert.equal(validSnapshotAccess(secret, 'draft-one', 'a'.repeat(40), a.token), true);
  assert.equal(validSnapshotAccess(secret, 'draft-two', 'a'.repeat(40), a.token), false);
  assert.equal(validSnapshotAccess(secret, 'draft-one', 'b'.repeat(40), a.token), false);
  assert.equal(
    validSnapshotAccess(
      secret,
      'draft-one',
      'a'.repeat(40),
      a.token.slice(0, -1) + (a.token.endsWith('a') ? 'b' : 'a'),
    ),
    false,
  );
  const now = Date.now;
  try {
    Date.now = () => a.expires + 1;
    assert.equal(validSnapshotAccess(secret, 'draft-one', 'a'.repeat(40), a.token), false);
  } finally {
    Date.now = now;
  }
});
test('HI-11: actual Shell routes signed frozen modules/JSON to dedicated preview; cookies stay private and wrong-key/bare-ID requests cannot use gateway auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-saved-gateway-')),
    previous = process.env.SITETILLER_CMS_ROOT;
  delete process.env.SITETILLER_CMS_ROOT;
  const children: any[] = [];
  let browser: any;
  try {
    const data = join(root, '.sitetiller'),
      settings = join(root, 'settings');
    await mkdir(settings, { recursive: true });
    const password = 'fixture-password';
    await writeFile(
      join(settings, 'shared.json'),
      JSON.stringify({ name: 'Fixture', theme: 'green', siteUrl: 'https://example.invalid/' }),
    );
    await writeFile(join(settings, 'auth.json'), JSON.stringify({ password: passwordHash(password) }));
    const project = new Project(join(data, 'project'));
    await project.init(null);
    await project.write({
      'site/index.html':
        '<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Snapshot</h1><output id="dynamic"></output><output id="isolation"></output><output id="studio-access"></output></main><script type="module" src="/viewer.js"></script></body></html>',
      'site/viewer.js':
        'import {paint} from "./viewer-helper.js";const rows=await(await fetch("cms/data/items.json")).json();paint(rows[0].title);try{parent.document.querySelector("#workspace");document.querySelector("#isolation").textContent="unsafe";}catch{document.querySelector("#isolation").textContent="isolated";}try{await(await fetch("/site/api/state")).json();document.querySelector("#studio-access").textContent="unsafe";}catch{document.querySelector("#studio-access").textContent="blocked";}',
      'site/viewer-helper.js': 'export function paint(value){document.querySelector("#dynamic").textContent=value;}',
      'site/cms/structure.json':
        '{"version":1,"folders":{},"lists":{"items":{"key":"id","columns":{"id":{"type":"text"},"title":{"type":"text"}}}}}',
      'site/cms/data/items.json': '[{"id":"one","title":"Frozen through gateway"}]',
    });
    const head = await project.commit('Snapshot baseline'),
      saved = await saveNamedDraft(project, { name: 'Gateway frozen state', expectedHead: head });
    await project.write({ 'site/cms/data/items.json': '[{"id":"one","title":"Later content"}]' });
    const current = await project.commit('Later content');
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        slots: [],
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        automaticReasoningPolicy: 1,
        publishedCommit: null,
        requests: [
          { id: 'baseline', sequence: 1, status: 'ready', commit: head, presentationChanged: true },
          {
            id: 'content',
            sequence: 2,
            status: 'ready',
            commit: current,
            presentationChanged: false,
            changeKind: 'content',
          },
        ],
      }),
    );
    const base = 24000 + Math.floor(Math.random() * 400),
      ai = base,
      preview = base + 500,
      shell = base + 1000,
      aiOrigin = 'http://127.0.0.1:' + ai,
      origin = 'http://127.0.0.1:' + shell,
      secret = 'fixture-gateway-secret';
    const launch = async (entry: string, env: any, ready: string) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {
        windowsHide: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          SITETILLER_OFFLINE: '1',
          SITETILLER_GATEWAY_TOKEN: secret,
          SITETILLER_DATA_DIR: data,
          SITETILLER_INSTANCE_ROOT: root,
          SITETILLER_CMS_ROOT: '',
          SITETILLER_PRODUCTION_HISTORY_DIR: '',
          SITETILLER_PUBLISH_URL: '',
          HOST: '127.0.0.1',
          EDIT_HOST: '127.0.0.1',
          ...env,
        },
        stdio: 'ignore',
      });
      children.push(child);
      for (let i = 0; i < 150; i++) {
        try {
          if ((await fetch(ready, { redirect: 'manual' })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error('Fixture child not ready');
    };
    await launch(
      '../src/server.ts',
      {
        PORT: String(ai),
        SITETILLER_ORIGIN: aiOrigin,
        SITETILLER_SHARED_AUTH_FILE: join(settings, 'auth.json'),
        SITETILLER_PREVIEW_URL: origin + '/preview/',
        SITETILLER_UI_LANGUAGE: 'cs',
      },
      aiOrigin + '/health',
    );
    await launch('../src/preview.ts', { PORT: String(preview) }, 'http://127.0.0.1:' + preview + '/health');
    await launch(
      '../../shell/server.ts',
      {
        PORT: String(shell),
        EDIT_ORIGIN: origin,
        AISTUDIO_PORT: String(ai),
        PREVIEW_PORT: String(preview),
        CMSTUDIO_PORT: '1',
      },
      origin + '/login',
    );
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(origin + '/login?next=%2Fsite%2F');
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button').click();
    // The Shell keeps studios alive in iframes of its frame page; the AI Studio is the frame under /site/.
    await page.waitForFunction(() => !!document.querySelector('iframe'));
    let studio: any;
    for (let i = 0; i < 300 && !studio; i++) {
      studio = page
        .frames()
        .find(
          (frame: any) =>
            frame.parentFrame() === page.mainFrame() &&
            new URL(frame.url() || 'about:blank', origin).pathname === '/site/',
        );
      if (!studio) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(studio);
    await studio.waitForFunction(
      () =>
        !!document.querySelector('#workspace') &&
        !document.querySelector('#workspace').hidden &&
        !document.querySelector('#workspace').hasAttribute('aria-busy'),
    );
    await studio.waitForSelector('#settings[open]');
    await studio.locator('#close-settings').click();
    await studio.locator('#drafts-tab').click();
    const leaseReply = page.waitForResponse((r) => r.url().endsWith('/site/api/drafts/preview'), { timeout: 180000 });
    await studio.locator('.saved-draft-card').first().click();
    assert.equal((await leaseReply).status(), 200);
    await studio
      .frameLocator('#preview')
      .locator('#dynamic')
      .filter({ hasText: 'Frozen through gateway' })
      .waitFor({ timeout: 180000 });
    assert.equal(await studio.frameLocator('#preview').locator('#dynamic').textContent(), 'Frozen through gateway');
    await studio.frameLocator('#preview').locator('#studio-access').filter({ hasText: 'blocked' }).waitFor();
    assert.equal(await studio.frameLocator('#preview').locator('#isolation').textContent(), 'isolated');
    assert.ok(!(await studio.locator('#preview').getAttribute('sandbox')).includes('allow-same-origin'));
    const url = new URL(await studio.locator('#preview').getAttribute('src'));
    assert.match(url.pathname, /^\/preview\/access\/[a-f0-9]{64}\/drafts\//);
    const dataReply = await fetch(new URL('cms/data/items.json', url));
    assert.equal(dataReply.status, 200);
    assert.equal(dataReply.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await dataReply.json())[0].title, 'Frozen through gateway');
    const wrong = new URL(url);
    wrong.pathname = wrong.pathname.replace(
      /([a-f0-9]{64})\/$/,
      (_, key) => key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a') + '/',
    );
    assert.equal((await fetch(wrong)).status, 401);
    const sessionOnly = new URL(url);
    sessionOnly.pathname = sessionOnly.pathname.replace(/access\/[0-9]{13}-[a-f0-9]{64}\/$/, '');
    assert.equal((await fetch(sessionOnly)).status, 401);
    assert.equal((await fetch(origin + '/site/preview/drafts/' + saved.id + '/', { redirect: 'manual' })).status, 303);
    const wrongInternal = wrong.pathname.replace(/^\/preview\/access\/[a-f0-9]{64}/, '/preview');
    assert.equal((await fetch(aiOrigin + wrongInternal, { headers: { 'x-sitetiller-gateway': secret } })).status, 401);
    assert.equal((await fetch(origin + '/site/api/state', { redirect: 'manual' })).status, 303);
    assert.equal(await project.head(), current);
  } finally {
    if (browser) await browser.close();
    for (const child of children.reverse()) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    if (previous === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
