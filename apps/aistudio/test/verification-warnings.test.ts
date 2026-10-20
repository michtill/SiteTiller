import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from '../src/project.ts';
import { workflow } from '../src/workflow.ts';
import { verificationOutcome } from '../src/verification-outcome.ts';
import { runBrowserScenario } from '../src/browser-scenarios.ts';
import { sharedModuleContext } from '../src/shared-modules.ts';
import { compactProgress } from '../ui/presentation.ts';
import { defaults } from '../src/core.ts';
const slots = [
    { provider: 'openai' as const, key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
    { provider: 'anthropic' as const, key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
  ],
  check = async () => ({ passed: true, errors: [], checks: [], screenshots: [] }),
  html =
    '<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main>Working</main><script src="app.js"></script></body></html>',
  baselineArchitecture = 'app.js owns interactions; runtime is the host website server.';
async function fixture(run: any) {
  const root = await mkdtemp(join(tmpdir(), 'example-verification-warnings-'));
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await project.write({ 'site/architecture.txt': baselineArchitecture });
    await project.commit('Architecture');
    await run(project, root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const implement = {
  action: 'implement',
  finalAnswer: 'Hotová úprava.',
  summary: 'Hotová úprava.',
  files: [
    { path: 'site/index.html', content: html },
    { path: 'site/app.js', content: 'window.answer=42;' },
  ],
};
test('AI-15: uncertainty preserves original verdict/evidence; only candidate-backed technical findings block; invalid protocol throws', () => {
  const files = { 'site/app.js': 'missingFunction();' },
    missing = { status: 'FAIL', requiredFixes: ['Chybí důkaz otevření dialogu.'] };
  const result = verificationOutcome(missing, files);
  assert.equal(result.status, 'PASS');
  assert.equal(result.modelVerdict, 'FAIL');
  assert.deepEqual(result.modelResult, missing);
  assert.deepEqual(result.warnings, missing.requiredFixes);
  const finding = { message: 'Undefined function called', path: 'site/app.js', evidence: 'missingFunction();' };
  assert.equal(verificationOutcome({ ...missing, technicalFindings: [finding] }, files).status, 'FAIL');
  assert.equal(
    verificationOutcome({ ...missing, technicalFindings: [{ ...finding, evidence: 'fabricated();' }] }, files).status,
    'PASS',
  );
  for (const invalid of [
    null,
    {},
    { status: 'UNKNOWN', requiredFixes: [] },
    { status: 'PASS', requiredFixes: 'invalid' },
    { status: 'PASS', requiredFixes: [], warnings: 'invalid' },
    { status: 'PASS', requiredFixes: [], technicalFindings: 'invalid' },
  ])
    assert.throws(() => verificationOutcome(invalid, files), /platný PASS\/FAIL/);
});
test('AI-15: unconfirmed FAIL finishes with two operational calls and one final response without repairs; warnings survive result, ready event and archived history', () =>
  fixture(async (project: any, root: string) => {
    let calls = 0;
    const events: any[] = [];
    const result = await workflow(
      project,
      slots,
      'Uprav interakci',
      join(root, 'drafts'),
      (e) => events.push(e),
      async (_c, _i, input) => {
        calls++;
        if (_c.textOnlyFinal) {
          assert.deepEqual(input.outcome.facts, [{ warnings: ['Chybí snímek dialogu.'] }]);
          return { value: { finalAnswer: 'Úspěch s upozorněním: Chybí snímek dialogu.' } };
        }
        if (input.testResults) {
          assert.equal(input.architecture, baselineArchitecture);
          assert.ok(Array.isArray(input.sharedModules));
          return { value: { status: 'FAIL', requiredFixes: ['Chybí snímek dialogu.'] } };
        }
        assert.equal(input.files['site/architecture.txt'], baselineArchitecture);
        return { value: implement };
      },
      undefined,
      [],
      { check },
    );
    assert.equal(calls, 3);
    assert.ok(result.commit);
    assert.equal(result.tests.analysis.modelVerdict, 'FAIL');
    assert.equal(result.tests.analysis.modelResult.requiredFixes[0], 'Chybí snímek dialogu.');
    assert.match(result.plan.summary, /Úspěch s upozorněním/);
    assert.deepEqual(result.tests.warnings, ['Chybí snímek dialogu.']);
    assert.deepEqual(events.findLast((e) => e.stage === 'ready').warnings, result.tests.warnings);
    const archived = compactProgress([], null, false, {}, [
      {
        id: 'archived',
        prompt: 'Uprav interakci',
        status: 'ready',
        commit: result.commit,
        tests: JSON.parse(JSON.stringify(result.tests)),
        plan: result.plan,
      },
    ]);
    assert.deepEqual(archived[0].rows[0].events.find((e) => e.stage === 'test').warnings, result.tests.warnings);
  }));
test('AI-15: candidate-backed technical FAIL still repairs and final verifier sees reconciled architecture', () =>
  fixture(async (project: any, root: string) => {
    let calls = 0,
      verifications = 0;
    const result = await workflow(
      project,
      slots,
      'Oprav interakci',
      join(root, 'drafts'),
      () => {},
      async (_c, _i, input) => {
        calls++;
        if (input.testResults) {
          verifications++;
          if (verifications === 1)
            return {
              value: {
                status: 'FAIL',
                requiredFixes: ['Calls undefined function'],
                technicalFindings: [
                  { message: 'Calls undefined function', path: 'site/app.js', evidence: 'missingFunction();' },
                ],
              },
            };
          assert.equal(input.architecture, 'app.js now sets the answer without missing calls.');
          return { value: { status: 'PASS', requiredFixes: [] } };
        }
        if (calls === 1)
          return {
            value: {
              ...implement,
              files: [implement.files[0], { path: 'site/app.js', content: 'missingFunction();' }],
            },
          };
        assert.equal(input.feedback.failedStep, 'verify');
        assert.equal(input.feedback.verification.modelVerdict, 'FAIL');
        return {
          value: {
            action: 'implement',
            finalAnswer: 'Technická chyba byla opravená.',
            files: [
              { path: 'site/app.js', content: 'window.answer=42;' },
              { path: 'site/architecture.txt', content: 'app.js now sets the answer without missing calls.' },
            ],
          },
        };
      },
      undefined,
      [],
      { check },
    );
    assert.equal(calls, 4);
    assert.equal(verifications, 2);
    assert.ok(result.commit);
    assert.equal((await project.files())['site/app.js'], 'window.answer=42;');
  }));
test('AI-15: provider errors and invalid verifier protocols remain errors in workflow', () =>
  fixture(async (project: any, root: string) => {
    const head = await project.head();
    for (const value of [
      { requiredFixes: [] },
      { status: 'BROKEN', requiredFixes: [] },
      { status: 'PASS', requiredFixes: 'broken' },
    ]) {
      await assert.rejects(
        workflow(
          project,
          slots,
          'Uprav interakci',
          join(root, 'drafts'),
          () => {},
          async (_c, _i, input) => ({ value: input.testResults ? value : implement }),
          undefined,
          [],
          { check },
        ),
        /platný PASS\/FAIL/,
      );
      assert.equal(await project.head(), head);
    }
    await assert.rejects(
      workflow(
        project,
        slots,
        'Uprav interakci',
        join(root, 'drafts'),
        () => {},
        async (_c, _i, input) => {
          if (input.testResults) throw Error('Provider unavailable');
          return { value: implement };
        },
        undefined,
        [],
        { check },
      ),
      /Provider unavailable/,
    );
    assert.equal(await project.head(), head);
  }));
test('AI-11: disabled controls call neither browser nor verifier and technical failures still block completion', () =>
  fixture(async (project: any, root: string) => {
    let calls = 0;
    const result = await workflow(
      project,
      slots,
      'Uprav interakci',
      join(root, 'drafts'),
      () => {},
      async () => {
        calls++;
        return { value: implement };
      },
      undefined,
      [],
      {
        requestChecks: { technical: false, verification: false },
        check: async () => {
          throw Error('Must not run');
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.tests.analysis.status, 'SKIPPED');
    const head = await project.head();
    let repaired = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Uprav interakci',
        join(root, 'drafts'),
        () => {},
        async () => {
          repaired++;
          return { value: { action: 'implement', files: [{ path: 'site/new.js', content: 'window.other=1;' }] } };
        },
        undefined,
        [],
        { check: async () => ({ passed: false, errors: ['Runtime error'], checks: [], screenshots: [] }) },
      ),
      /neprošla kontrolou/,
    );
    assert.ok(repaired >= 3);
    assert.equal(await project.head(), head);
  }));
test('AI-15: scenario budget remains failed evidence; concrete assertion containing timeout words is not reclassified', async () => {
  const testCase = {
      name: 'Budget',
      path: 'site/index.html',
      steps: [{ action: 'expectText', selector: 'output', equals: 'correct' }],
    },
    page = { locator: () => ({ textContent: async () => 'timeout exceeded' }), waitForTimeout: async () => {} };
  const budget = await runBrowserScenario(page, testCase, 0);
  assert.equal(budget.passed, false);
  assert.equal(budget.failureKind, 'budget');
  const assertion = await runBrowserScenario(page, testCase, 30000);
  assert.equal(assertion.passed, false);
  assert.equal(assertion.failureKind, 'assertion');
  assert.equal(assertion.steps[0].actual, 'timeout exceeded');
});
test('AI-15: shared modules are found statically for every page that uses them, with changed and removed exports, without execution', () => {
  const old = {
    'site/index.html': '<script type="module" src="index.js?v=1"></script>',
    'site/index.js': 'import {render} from "./lib/widget.js";',
    'site/about/index.html': '<script type="module">import {render} from "../lib/widget.js?v=2";</script>',
    'site/lib/widget.js': 'export function render(){} export function attachEvents(){}',
  };
  const next = { ...old, 'site/lib/widget.js': 'export function render(){}', 'site/index.js': '' };
  const modules = sharedModuleContext(next, old);
  assert.equal(modules.length, 1);
  assert.deepEqual(modules[0].pages, ['site/about/index.html', 'site/index.html']);
  assert.equal(modules[0].changed, true);
  assert.deepEqual(modules[0].previousExports, ['render', 'attachEvents']);
  assert.deepEqual(modules[0].currentExports, ['render']);
  const removed = { ...next };
  delete removed['site/lib/widget.js'];
  assert.equal(sharedModuleContext(removed, old)[0].afterBytes, 0);
  assert.deepEqual(
    sharedModuleContext({
      'site/index.html': '<script src="https://external.test/app.js"></script><script src="a.js"></script>',
      'site/a.js': 'import "./b.js";',
      'site/b.js': 'import "./a.js";',
    }),
    [],
  );
});
