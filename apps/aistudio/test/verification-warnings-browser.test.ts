import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserChecks } from '../src/checks.ts';
import { validateBrowserTests } from '../src/browser-scenarios.ts';
const html =
    '<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>Working</main></body></html>',
  scenario = [
    {
      name: 'Unreachable selector',
      path: 'site/index.html',
      steps: [{ action: 'expectText', selector: '#absent', equals: 'Expected' }],
    },
  ];
test('AI-15: timeouts warn with failed scenario evidence; actual JS and local HTTP errors still block; invalid schemas throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'example-unverified-browser-'));
  try {
    const result = await browserChecks(root, { 'site/index.html': html }, scenario);
    assert.equal(result.passed, true);
    assert.equal(result.scenarios[0].passed, false);
    assert.equal(result.scenarios[0].failureKind, 'timeout');
    assert.ok(result.warnings.some((w) => w.includes('Interakci se nepodařilo ověřit')));
    const broken = await browserChecks(
      root,
      { 'site/index.html': html.replace('</body>', '<script>throw Error("real technical defect")</script></body>') },
      scenario,
    );
    assert.equal(broken.passed, false);
    assert.ok(broken.errors.some((e) => e.includes('real technical defect')));
    const failedHTTP = await browserChecks(
      root,
      { 'site/index.html': html.replace('</body>', '<script>fetch("/missing.json")</script></body>') },
      scenario,
    );
    assert.equal(failedHTTP.passed, false);
    assert.ok(failedHTTP.errors.some((e) => e.includes('HTTP 404')));
    await assert.rejects(
      browserChecks(root, { 'site/index.html': html }, [
        { name: 'Invalid', path: 'site/index.html', steps: [{ action: 'execute', selector: 'body' }] },
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-15: a change in one page keeps a shared module working (geometry, colors, callback payload, destroy) for every page that uses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'example-shared-consumers-'));
  try {
    const renderer =
      'export function render(){document.querySelector("main").innerHTML=\'<svg viewBox="0 0 400 300"><path class="hit-area" fill="red" d="M0 0H400V300H0Z"></path></svg><output id="payload"></output><output id="cleanup"></output>\';} export function attach(callback){document.querySelector(".hit-area").onclick=()=>callback({item:7});return {destroy(){document.querySelector("#cleanup").textContent="destroyed";}};}';
    const script =
        'import {render,attach} from "/lib/widget.js";render();const handle=attach(value=>{document.querySelector("#payload").textContent=String(value.item);handle.destroy();});',
      files = {
        'site/index.html': html.replace('</body>', '<script type="module" src="app.js"></script></body>'),
        'site/about/index.html': html.replace('</body>', '<script type="module" src="/app.js"></script></body>'),
        'site/app.js': script,
        'site/lib/widget.js': renderer,
      },
      candidate = { ...files, 'site/app.js': script + 'document.querySelector("svg").style.cursor="default";' };
    const scenarios = ['site/index.html', 'site/about/index.html'].map((path) => ({
      name: 'Renderer contracts ' + path,
      path,
      steps: [
        { action: 'expectAttribute', selector: 'svg', attribute: 'viewBox', value: '0 0 400 300' },
        { action: 'expectAttribute', selector: '.hit-area', attribute: 'fill', value: 'red' },
        { action: 'click', selector: '.hit-area' },
        { action: 'expectText', selector: '#payload', equals: '7' },
        { action: 'expectText', selector: '#cleanup', equals: 'destroyed' },
      ],
    }));
    validateBrowserTests(scenarios, candidate);
    assert.equal(candidate['site/lib/widget.js'], renderer);
    const result = await browserChecks(root, candidate, scenarios);
    assert.equal(result.passed, true, JSON.stringify(result.errors));
    assert.equal(result.scenarios.length, 4);
    assert.ok(
      result.scenarios.every((s) => s.passed),
      JSON.stringify(result.scenarios),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
