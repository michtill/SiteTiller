import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestChecks } from '../src/request-checks.ts';
import { Project } from '../src/project.ts';
import { workflow } from '../src/workflow.ts';
test('AI-11: request check defaults and strict API input', () => {
  assert.deepEqual(requestChecks(undefined), { technical: true, verification: true });
  assert.deepEqual(requestChecks({ technical: false }), { technical: false, verification: true });
  for (const v of [null, [], { technical: 'false' }, { surprise: true }]) assert.throws(() => requestChecks(v));
});
test('AI-11: each check can be skipped independently without agent overriding owner choice', async () => {
  for (const technical of [true, false])
    for (const verification of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), 'request-checks-'));
      try {
        const project = new Project(join(root, 'project'));
        await project.init(null);
        let browserCalls = 0,
          verifyCalls = 0;
        const events: any[] = [];
        const result = await workflow(
          project,
          [{ provider: 'openai', key: 'fake', highModel: 'fake', lowModel: 'fake' }],
          'Simple change',
          join(root, 'drafts'),
          (e) => events.push(e),
          async (client, instruction, input) => {
            if (input.testResults) {
              verifyCalls++;
              return { value: { status: 'PASS', requiredFixes: [] } };
            }
            assert.equal(input.requestChecks.technical, technical);
            assert.equal(input.requestChecks.verification, verification);
            return {
              value: {
                action: 'implement',
                finalAnswer: 'Úprava je hotová.',
                needsVerification: true,
                acceptance: [{ id: 'change', category: 'required', basis: 'User', description: 'Update page' }],
                browserTests: technical ? [] : 'invalid agent scenarios should be ignored when checks disabled',
                files: [
                  {
                    path: 'site/index.html',
                    content:
                      '<!doctype html><html><head><title>Changed</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>Changed</body></html>',
                  },
                ],
              },
            };
          },
          undefined,
          [],
          {
            mode: 'create',
            requestChecks: { technical, verification },
            check: async () => {
              browserCalls++;
              return { passed: true, errors: [], checks: [], screenshots: [] } as any;
            },
          },
        );
        assert.ok(result.commit);
        assert.equal(browserCalls, technical ? 1 : 0);
        assert.equal(verifyCalls, verification ? 1 : 0);
        assert.equal(result.tests.static.skipped === true, !technical);
        assert.equal(result.tests.analysis?.status === 'SKIPPED', !verification);
        if (!technical)
          assert.ok(!events.some((e) => e.stage === 'test' && e.message === 'Technické kontroly prošly.'));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
});
