import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readResponseLanguage, prepareFinalAnswer, hostAnswer, primaryFinalContract } from '../src/final-answer.ts';
import { callModel } from '../src/providers.ts';
import { withRules } from '../src/instructions.ts';
import { Project } from '../src/project.ts';
import { workflow } from '../src/workflow.ts';
import { compactProgress, displayMessage } from '../ui/presentation.ts';
const slots: any = [
    { provider: 'openai', key: 'fake', highModel: 'fake', lowModel: 'fake' },
    { provider: 'anthropic', key: 'fake', highModel: 'fake', lowModel: 'fake' },
  ],
  client: any = { provider: 'openai', key: 'fake', model: 'fake' };
async function fixture(run: any) {
  const parent = resolve(tmpdir()),
    root = await mkdtemp(join(parent, 'final-answer-fixture-'));
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    await run(project, root);
  } finally {
    assert.ok(resolve(root).startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  }
}
test('AI-01: shared language authority absent cs, invalid/read failures, frozen request and next request refresh', async () => {
  await fixture(async (p, root) => {
    const path = join(root, 'shared.json');
    assert.equal(await readResponseLanguage(path), 'cs');
    await writeFile(path, '{}');
    assert.equal(await readResponseLanguage(path), 'cs');
    await writeFile(path, '{"language":"en"}');
    const frozen = await readResponseLanguage(path);
    await writeFile(path, '{"language":"cs"}');
    assert.equal(frozen, 'en');
    assert.equal(await readResponseLanguage(path), 'cs');
    for (const text of ['broken', 'null', '[]', '{"language":"de"}']) {
      await writeFile(path, text);
      await assert.rejects(readResponseLanguage(path));
    }
    await assert.rejects(readResponseLanguage(root));
  });
});
test('AI-01: deterministic host templates use fixed language and preserve authored values without calls', () => {
  for (const kind of ['readonly', 'sourceUnavailable', 'sourceChoice'] as const) {
    assert.notEqual(hostAnswer(kind, 'cs'), hostAnswer(kind, 'en'));
  }
  const choices = [{ collection: 'tracks', field: 'title', value: '日本語 – Song' }];
  assert.ok(hostAnswer('sourceChoice', 'cs', choices).includes(choices[0].value));
  assert.ok(hostAnswer('sourceChoice', 'en', choices).includes(choices[0].value));
});
test('AI-21: complete explicit primary final reuses zero calls; specialist final ignored and all facts use one primary text-only call', async () => {
  let calls = 0;
  const stub: any = async (slot, instruction, input) => {
    calls++;
    assert.equal(slot.textOnlyFinal, true);
    assert.equal(slot.provider, 'openai');
    assert.ok(!input.files && !input.originalRequest && !input.tools && !input.roleState);
    assert.match(instruction, /Czech/);
    assert.deepEqual(input.outcome.facts, [{ warnings: ['Unverified keyboard interaction'] }]);
    return { value: { finalAnswer: 'Úprava je připravená. Ovládání klávesnicí nebylo ověřené.' } };
  };
  assert.equal(
    await prepareFinalAnswer({
      language: 'cs',
      role: 'primary',
      value: { action: 'answer', finalAnswer: 'Hotovo.' },
      summary: 'internal English',
      client,
      modelCall: stub,
    }),
    'Hotovo.',
  );
  assert.equal(calls, 0);
  const text = await prepareFinalAnswer({
    language: 'cs',
    role: 'ui',
    value: { finalAnswer: 'Do not reuse' },
    facts: [{ warnings: ['Unverified keyboard interaction'] }],
    summary: 'internal English',
    client,
    modelCall: stub,
  });
  assert.equal(calls, 1);
  assert.ok(!text.includes('Unverified'));
});
test('AI-21: invalid final output rejects once, no actions accepted and localized error', async () => {
  for (const language of ['cs', 'en'] as const) {
    for (const value of [{ finalAnswer: '' }, { finalAnswer: 'ok', files: [] }, { action: 'implement' }, null]) {
      let calls = 0;
      await assert.rejects(
        prepareFinalAnswer({
          language,
          role: 'ui',
          summary: 'x',
          client,
          modelCall: async () => {
            calls++;
            return { value };
          },
        }),
        (e) =>
          e.finalizationFailure === true &&
          (language === 'en'
            ? e.message.includes('Changes were not saved')
            : e.message.includes('Změny nebyly uložené')),
      );
      assert.equal(calls, 1);
    }
  }
});
test('AI-21: real provider final envelope has bounded output/no tools/no retries on malformed or truncated; internal fields unrestricted', async () => {
  for (const provider of ['openai', 'anthropic'])
    for (const truncated of [false, true]) {
      let calls = 0;
      await assert.rejects(
        callModel(
          { ...client, provider, textOnlyFinal: true },
          'Final only',
          { finalResponseLanguage: 'cs' },
          async (_url, options: any) => {
            calls++;
            const body = JSON.parse(options.body);
            assert.ok(!body.tools && !body.tool_choice);
            assert.equal(body.max_output_tokens || body.max_tokens, 4096);
            assert.doesNotMatch(body.instructions || body.system, /ALL human-facing|language of originalRequest/);
            return Response.json(
              provider === 'openai'
                ? {
                    output: [{ content: [{ type: 'output_text', text: 'NOT JSON' }] }],
                    ...(truncated ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } : {}),
                  }
                : { content: [{ type: 'text', text: 'NOT JSON' }], stop_reason: truncated ? 'max_tokens' : 'end_turn' },
            );
          },
        ),
      );
      assert.equal(calls, 1);
    }
  assert.doesNotMatch(withRules('ui', 'Internal'), /MUST match the original/);
  assert.match(primaryFinalContract, /finalResponseLanguage/);
});
test('AI-01: workflow fixed language despite arbitrary request, content bytes unchanged, live/archive final verbatim', async () => {
  for (const [responseLanguage, prompt, finalAnswer] of [
    ['cs', 'What is this website?', 'Toto je váš web.'],
    ['en', 'Co je tento web?', 'This is your website.'],
    ['en', 'これは何ですか？', 'This is your website.'],
  ])
    await fixture(async (project, root) => {
      const before = await project.head(),
        files = await project.files(),
        events: any[] = [];
      let calls = 0;
      const result = await workflow(
        project,
        slots,
        prompt,
        join(root, 'drafts'),
        (e) => events.push(e),
        async (_slot, _instruction, input) => {
          calls++;
          assert.equal(input.finalResponseLanguage, responseLanguage);
          return { value: { action: 'answer', summary: 'English internal summary', finalAnswer } };
        },
        undefined,
        [],
        { responseLanguage } as any,
      );
      assert.equal(calls, 1);
      assert.equal(await project.head(), before);
      assert.deepEqual(await project.files(), files);
      assert.equal(result.finalAnswer, finalAnswer);
      assert.equal(events.find((e) => e.stage === 'final-answer').message, finalAnswer);
      const archived = compactProgress(
        [],
        null,
        false,
        {},
        [{ id: 'x', prompt, status: 'answered', finalAnswer: result.finalAnswer, plan: result.plan }],
        [],
      );
      assert.equal(
        displayMessage(
          archived[0].events.find((e) => e.stage === 'final-answer'),
          () => 'WRONG UI TRANSLATION',
        ),
        finalAnswer,
      );
    });
});
test('AI-32: workflow explicit primary reuse before commit and complete optional-order fact finalization', async () => {
  await fixture(async (project, root) => {
    const before = await project.head(),
      original = await project.files(),
      events: any[] = [];
    let finals = 0;
    const check: any = async () => ({
        passed: true,
        errors: [],
        checks: [],
        screenshots: [],
        warnings: ['Keyboard behavior unverified'],
      }),
      result = await workflow(
        project,
        slots,
        'Change appearance',
        join(root, 'drafts'),
        (e) => events.push(e),
        async (slot, instruction, input) => {
          if (slot.textOnlyFinal) {
            finals++;
            assert.equal(await project.head(), before);
            assert.ok(input.outcome.facts.some((f) => f.warnings?.includes('Keyboard behavior unverified')));
            return { value: { finalAnswer: 'Vzhled byl upraven. Ovládání klávesnicí nebylo ověřené.' } };
          }
          return {
            value: {
              action: 'implement',
              summary: 'Appearance updated',
              finalAnswer: 'Vzhled byl upraven.',
              files: [
                {
                  path: 'site/index.html',
                  content: original['site/index.html'].replace('</head>', '<style>body{color:blue}</style></head>'),
                },
              ],
              browserTests: [{ id: 'show', steps: [{ action: 'assertText', selector: 'h1', text: 'Nový web' }] }],
            },
          };
        },
        undefined,
        [],
        { responseLanguage: 'cs', check, requestChecks: { technical: false, verification: false } },
      );
    assert.ok(result.commit);
    assert.equal(finals, 0);
    assert.equal(result.finalAnswer, 'Vzhled byl upraven.');
    assert.equal(result.plan.summary, result.finalAnswer);
    assert.equal(events.find((e) => e.stage === 'final-answer').message, result.finalAnswer);
  });
  const answer = await prepareFinalAnswer({
    language: 'cs',
    role: 'primary',
    value: { action: 'answer', finalAnswer: 'Hotovo.' },
    summary: 'Changed',
    facts: [
      { optionalOrderLeftBlank: ['tracks.position'] },
      { orderInferredNotLiteral: ['tracks.other'] },
      { warnings: ['Keyboard behavior unverified'] },
    ],
    client,
    modelCall: async (_slot, _instruction, input) => {
      assert.equal(input.outcome.facts.length, 3);
      return {
        value: {
          finalAnswer: 'Pořadí tracks.position zůstalo prázdné; tracks.other je odvozené. Klávesnice nebyla ověřená.',
        },
      };
    },
  });
  assert.ok(answer.includes('zůstalo prázdné'));
});
test('AI-21: finalization failure before mutation preserves HEAD/files and does not source-retry; confirmed mutation remains successful on emitter failure', async () => {
  await fixture(async (project, root) => {
    const before = await project.head(),
      original = await project.files();
    let calls = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Change appearance',
        join(root, 'drafts'),
        () => {},
        async (slot) => {
          calls++;
          if (slot.textOnlyFinal) throw Error('fixture outage');
          return {
            value: {
              action: 'implement',
              summary: 'Changed',
              files: [
                {
                  path: 'site/index.html',
                  content: original['site/index.html'].replace('</head>', '<style>body{color:blue}</style></head>'),
                },
              ],
            },
          };
        },
        undefined,
        [],
        { responseLanguage: 'en', requestChecks: { technical: false, verification: false } },
      ),
      (e) => e.finalizationFailure === true,
    );
    assert.equal(calls, 2);
    assert.equal(await project.head(), before);
    assert.deepEqual(await project.files(), original);
    const result = await workflow(
      project,
      slots,
      'Change appearance',
      join(root, 'drafts'),
      (e) => {
        if (e.stage === 'final-answer') throw Error('presentation failure');
      },
      async () => ({
        value: {
          action: 'implement',
          summary: 'Changed',
          finalAnswer: 'The appearance was changed.',
          files: [
            {
              path: 'site/index.html',
              content: original['site/index.html'].replace('</head>', '<style>body{color:blue}</style></head>'),
            },
          ],
        },
      }),
      undefined,
      [],
      { responseLanguage: 'en', requestChecks: { technical: false, verification: false } },
    );
    assert.equal(await project.head(), result.commit);
    assert.equal(result.finalAnswer, 'The appearance was changed.');
  });
});
test('AI-21: source unavailable host uses no finalizer; finalizer failure after source read does not re-read source', async () => {
  for (const failRead of [true, false])
    await fixture(async (project, root) => {
      let calls = 0,
        reads = 0,
        finals = 0;
      const original = await project.files(),
        head = await project.head();
      const run = () =>
        workflow(
          project,
          slots,
          'Explain https://example.org/source',
          join(root, 'drafts'),
          () => {},
          async (slot) => {
            calls++;
            if (slot.textOnlyFinal) {
              finals++;
              throw Error('invalid finalizer');
            }
            if (calls === 1)
              return {
                value: { action: 'web', purpose: 'source', url: 'https://example.org/source', summary: 'Read' },
              };
            return { value: { action: 'answer', summary: 'Explanation' } };
          },
          undefined,
          [],
          {
            responseLanguage: 'en',
            webSource: async () => {
              reads++;
              if (failRead) throw Error('source unavailable');
              return {
                id: 's',
                url: 'https://example.org/source',
                text: 'Source facts',
                citationText: 'Source facts',
                structuredData: [],
              };
            },
          },
        );
      if (failRead) {
        const result = await run();
        assert.equal(result.finalAnswer, hostAnswer('sourceUnavailable', 'en'));
        assert.equal(finals, 0);
      } else {
        await assert.rejects(run(), (e) => e.finalizationFailure === true);
        assert.equal(finals, 1);
      }
      assert.equal(reads, 1);
      assert.equal(await project.head(), head);
      assert.deepEqual(await project.files(), original);
    });
});

test('AI-01: actual workflow internal English warnings become one complete Czech final before commit and archive matches', () =>
  fixture(async (project, root) => {
    const original = await project.files(),
      head = await project.head(),
      events: any[] = [];
    let finals = 0;
    const result = await workflow(
      project,
      slots,
      'Uprav vzhled',
      join(root, 'drafts'),
      (e) => events.push(e),
      async (slot, _instruction, input) => {
        if (slot.textOnlyFinal) {
          finals++;
          assert.equal(await project.head(), head);
          assert.deepEqual(input.outcome.facts, [{ warnings: ['Keyboard behavior unverified'] }]);
          return { value: { finalAnswer: 'Vzhled je upraven. Ovládání klávesnicí nebylo ověřené.' } };
        }
        return {
          value: {
            action: 'implement',
            summary: 'Changed',
            finalAnswer: 'Vzhled je upraven.',
            files: [
              {
                path: 'site/index.html',
                content: original['site/index.html'].replace(
                  'Vytvořte web zadáním požadavku v SiteTiller.',
                  'Changed content intentionally',
                ),
              },
            ],
          },
        };
      },
      undefined,
      [],
      {
        responseLanguage: 'cs',
        requestChecks: { technical: true, verification: false },
        check: async () =>
          ({
            passed: true,
            errors: [],
            checks: [],
            screenshots: [],
            warnings: ['Keyboard behavior unverified'],
          }) as any,
      },
    );
    assert.equal(finals, 1);
    assert.equal(result.finalAnswer, result.plan.summary);
    assert.equal(events.find((e) => e.stage === 'final-answer').message, result.finalAnswer);
    assert.ok(!result.finalAnswer.includes('Keyboard'));
    assert.deepEqual(result.tests.warnings, ['Keyboard behavior unverified']);
    const archived = compactProgress(
      [],
      null,
      false,
      {},
      [
        {
          id: 'x',
          prompt: 'Uprav vzhled',
          status: 'ready',
          commit: result.commit,
          finalAnswer: result.finalAnswer,
          plan: result.plan,
        },
      ],
      [],
    );
    assert.equal(archived[0].events.find((e) => e.stage === 'final-answer').message, result.finalAnswer);
  }));
test('AI-21: terminal specialist summary uses existing primary exactly once, no language context leaks into specialist', () =>
  fixture(async (project, root) => {
    const original = await project.files(),
      head = await project.head();
    let leads = 0,
      specialists = 0,
      finals = 0;
    const result = await workflow(
      project,
      slots,
      'Change appearance',
      join(root, 'drafts'),
      () => {},
      async (slot, instruction, input) => {
        if (slot.textOnlyFinal) {
          finals++;
          assert.equal(slot.provider, 'openai');
          assert.equal(await project.head(), head);
          return { value: { finalAnswer: 'Vzhled byl změněn.' } };
        }
        if (input.roleState.role === 'primary') {
          leads++;
          return {
            value: {
              action: 'delegate',
              scope: 'edit',
              resolvedRequest: 'Change appearance',
              task: 'Change appearance',
              acceptance: [
                { id: 'appearance', category: 'required', description: 'Change appearance', basis: 'User request' },
              ],
              summary: 'Internal lead note',
            },
          };
        }
        specialists++;
        assert.equal(input.finalResponseLanguage, undefined);
        assert.doesNotMatch(instruction, /ALL human-facing|MUST match the original/);
        return {
          value: {
            action: 'implement',
            summary: 'Internal specialist note',
            finalAnswer: 'Never reuse specialist',
            files: [
              {
                path: 'site/index.html',
                content: original['site/index.html'].replace('</head>', '<style>body{color:blue}</style></head>'),
              },
            ],
          },
        };
      },
      undefined,
      [],
      { responseLanguage: 'cs', requestChecks: { technical: false, verification: false } },
    );
    assert.equal(leads, 1);
    assert.equal(specialists, 1);
    assert.equal(finals, 1);
    assert.equal(result.finalAnswer, 'Vzhled byl změněn.');
  }));
test('AI-21: source choice returns a deterministic localized no-write answer without finalizer or source-repair retry', () =>
  fixture(async (project, root) => {
    const defs = { lists: { tracks: { key: 'id', columns: { id: { type: 'generated' }, title: { type: 'text' } } } } };
    await project.write({ 'site/cms/structure.json': JSON.stringify(defs), 'site/cms/data/tracks.json': '[]' });
    await project.commit('Source fixture');
    const original = await project.files(),
      head = await project.head();
    let calls = 0,
      reads = 0;
    const result = await workflow(
      project,
      slots,
      'Najdi seznam skladeb a přidej je do obsahu skladeb https://example.org/source',
      join(root, 'drafts'),
      () => {},
      async (slot) => {
        assert.ok(!slot.textOnlyFinal);
        calls++;
        if (calls === 1) return { value: { action: 'web', purpose: 'source', url: 'https://example.org/source' } };
        if (calls === 2) return { value: { action: 'read', paths: Object.keys(original) } };
        return {
          value: {
            action: 'implement',
            summary: 'Unverified internal note',
            files: [{ path: 'site/cms/data/tracks.json', content: '[{"id":"","title":"Authored 日本語"}]' }],
          },
        };
      },
      undefined,
      [],
      {
        responseLanguage: 'en',
        webSource: async () => {
          reads++;
          return {
            id: 's',
            url: 'https://example.org/source',
            text: 'No matching song',
            citationText: 'No matching song',
            structuredData: [],
          };
        },
      },
    );
    assert.equal(calls, 3);
    assert.equal(reads, 1);
    assert.equal(result.conversationOnly, true);
    assert.match(result.finalAnswer, /These proposed values/);
    assert.ok(result.finalAnswer.includes('Authored 日本語'));
    assert.equal(await project.head(), head);
    assert.deepEqual(await project.files(), original);
  }));

test('AI-32: actual optional-order warning is prepared before commit and identical in event, saved result and archive', () =>
  fixture(async (project, root) => {
    const defs = {
      lists: {
        tracks: {
          key: 'id',
          columns: { id: { type: 'generated' }, title: { type: 'text' }, position: { type: 'number' } },
        },
      },
    };
    await project.write({ 'site/cms/structure.json': JSON.stringify(defs), 'site/cms/data/tracks.json': '[]' });
    await project.commit('Optional order fixture');
    const original = await project.files(),
      head = await project.head(),
      events: any[] = [];
    let calls = 0,
      finals = 0;
    const result = await workflow(
      project,
      slots,
      'Najdi seznam skladeb a přidej je do obsahu skladeb https://example.org/source',
      join(root, 'drafts'),
      (e) => events.push(e),
      async (slot, _i, input) => {
        if (slot.textOnlyFinal) {
          finals++;
          assert.equal(await project.head(), head);
          assert.deepEqual(input.outcome.facts, [{ optionalOrderLeftBlank: ['tracks.position'] }]);
          return {
            value: { finalAnswer: 'Skladba byla přidána. Nepovinné neověřené pořadí tracks.position zůstalo prázdné.' },
          };
        }
        calls++;
        if (calls === 1) return { value: { action: 'web', purpose: 'source', url: 'https://example.org/source' } };
        if (calls === 2) return { value: { action: 'read', paths: Object.keys(original) } };
        return {
          value: {
            action: 'implement',
            summary: 'Internal English note',
            finalAnswer: 'Nepřebírat neúplnou odpověď.',
            files: [{ path: 'site/cms/data/tracks.json', content: '[{"id":"","title":"Real Song","position":"99"}]' }],
            sourceFacts: [
              { sourceId: 's', collection: 'tracks', field: 'title', value: 'Real Song', quote: 'Real Song' },
            ],
          },
        };
      },
      undefined,
      [],
      {
        responseLanguage: 'cs',
        requestChecks: { technical: false, verification: false },
        webSource: async () => ({
          id: 's',
          url: 'https://example.org/source',
          text: 'Real Song',
          citationText: 'Real Song',
          structuredData: [],
        }),
      },
    );
    assert.equal(finals, 1);
    assert.equal(JSON.parse((await project.files())['site/cms/data/tracks.json'])[0].position, '');
    assert.equal(result.plan.summary, result.finalAnswer);
    assert.equal(events.find((e) => e.stage === 'final-answer').message, result.finalAnswer);
    const archived = compactProgress(
      [],
      null,
      false,
      {},
      [
        {
          id: 'x',
          status: 'ready',
          prompt: 'Task',
          commit: result.commit,
          finalAnswer: result.finalAnswer,
          plan: result.plan,
        },
      ],
      [],
    );
    assert.equal(archived[0].events.find((e) => e.stage === 'final-answer').message, result.finalAnswer);
  }));
