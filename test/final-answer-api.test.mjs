import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { isolatedStack } from './support/stack.mjs';
import { readJson } from '../packages/settings/index.mjs';
import { launchBrowser, studioFrame } from './support/browser.mjs';
let studio;
test('AI-01: actual disposable API ignores client language, freezes shared setting per request, persists finalAnswer and renders archived text verbatim', async () => {
  const stack = await isolatedStack({ controllerImports: ['test/support/final-answer-provider.mjs'] });
  let browser;
  try {
    const login = await fetch(stack.origin + '/login', {
      method: 'POST',
      headers: { Origin: stack.origin },
      body: new URLSearchParams({ password: stack.password }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0],
      headers = { Cookie: cookie, Origin: stack.origin, 'Content-Type': 'application/json' },
      shared = join(stack.root, 'settings/shared.json'),
      initial = await readJson(shared),
      publicBefore = await readFile(join(stack.root, '.production/current.json'), 'utf8'),
      schemaBefore = await readFile(join(stack.root, 'schema/structure.json'), 'utf8');
    const state = async () => await (await fetch(stack.origin + '/site/api/state', { headers })).json();
    const run = async (prompt, clientLanguage) => {
      const r = await fetch(stack.origin + '/site/api/run', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt,
          responseLanguage: clientLanguage,
          checks: { technical: false, verification: false },
        }),
      });
      assert.equal(r.status, 202);
    };
    const wait = async () => {
      for (let i = 0; i < 150; i++) {
        const s = await state();
        if (!s.busy) return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw Error('Fixture job timeout');
    };
    await writeFile(shared, JSON.stringify({ ...initial, language: 'cs' }));
    await run('What is this website?', 'en');
    let entered = false;
    for (let i = 0; i < 150; i++) {
      try {
        assert.equal((await readJson(join(stack.root, 'fixture-provider-entered.json'))).language, 'cs');
        entered = true;
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(entered);
    await writeFile(shared, JSON.stringify({ ...initial, language: 'en' }));
    await writeFile(join(stack.root, 'fixture-provider-release'), 'release');
    let s = await wait();
    assert.equal(s.requests.at(-1).responseLanguage, 'cs');
    assert.equal(s.requests.at(-1).finalAnswer, 'Toto je váš web.');
    await run('Co je tento web?', 'cs');
    s = await wait();
    assert.equal(s.requests.at(-1).responseLanguage, 'en');
    assert.equal(s.requests.at(-1).finalAnswer, 'This is your website.');
    await run('これは何ですか？', 'cs');
    s = await wait();
    assert.equal(s.requests.at(-1).finalAnswer, 'This is your website.');
    const stored = await readJson(join(stack.root, '.sitetiller/config.json'));
    assert.deepEqual(
      stored.requests.map((r) => r.finalAnswer),
      s.requests.map((r) => r.finalAnswer),
    );
    const trace = await readJson(join(stack.root, 'fixture-provider-trace.json'));
    assert.equal(trace.length, 3);
    assert.ok(trace.every((t) => !t.tools));
    assert.deepEqual(
      trace.map((t) => t.language),
      ['cs', 'en', 'en'],
    );
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'sitetiller_edit', value: cookie.split('=')[1], url: stack.origin }]);
    await page.goto(stack.origin + '/site/');
    studio = await studioFrame(page, 'site');
    await studio.locator('.response-text').first().waitFor();
    assert.equal(await studio.locator('html').getAttribute('data-shared-language'), 'en');
    let texts = await studio.locator('.chat-answer .response-text').allTextContents();
    assert.ok(texts.includes('Toto je váš web.'));
    assert.equal(texts.filter((t) => t === 'This is your website.').length, 2);
    await page.reload();
    studio = await studioFrame(page, 'site');
    await studio.locator('.response-text').first().waitFor();
    assert.deepEqual(await studio.locator('.chat-answer .response-text').allTextContents(), texts);
    const count = s.requests.length;
    await writeFile(shared, 'BROKEN JSON');
    const invalid = await fetch(stack.origin + '/site/api/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'Another question' }),
    });
    // Unreadable shared settings reject the request before anything is stored.
    assert.equal(invalid.status, 400);
    await writeFile(shared, JSON.stringify({ ...initial, language: 'en' }));
    assert.equal((await state()).requests.length, count);
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), publicBefore);
    assert.equal(await readFile(join(stack.root, 'schema/structure.json'), 'utf8'), schemaBefore);
  } finally {
    await browser?.close();
    await stack.close();
  }
});
