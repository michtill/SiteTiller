import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project.ts';
import { workflow } from './fixtures/workflow.ts';
const slots = [
    { provider: 'openai', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
    { provider: 'anthropic', key: 'fixture', highModel: 'fixture', lowModel: 'fixture' },
  ],
  criteria = [{ id: 'exact', category: 'required', description: 'Preserve calculations', basis: 'User request' }],
  check = async () => ({ passed: true, errors: [], checks: [], screenshots: [] });
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'example-bounded-'));
  try {
    const project = new Project(join(root, 'project'));
    await project.init(null);
    return await run(project, root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
test('AI-16: specialist blocked returns preserved staged candidate/findings to lead; >50kB extraction reaches verified Git', () =>
  fixture(async (project, root) => {
    const code = 'const calculation=1;\r\n' + '/* unchanged Žluťoučký */'.repeat(3000),
      html =
        '<!doctype html><html><head><title>Test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>' +
        code +
        '</script></body></html>';
    await project.write({ 'site/index.html': html, 'site/unused.txt': 'unread' });
    await project.commit('Baseline');
    let rounds = 0,
      verified = false;
    const result = await workflow(
      project,
      slots,
      'Extract existing script',
      join(root, 'drafts'),
      () => {},
      async (_c, _i, input) => {
        if (input.testResults) {
          verified = true;
          return { value: { status: 'PASS', requiredFixes: [] } };
        }
        switch (++rounds) {
          case 1:
            return { value: { action: 'stage', files: [{ path: 'site/style.css', content: 'body{color:blue}' }] } };
          case 2:
            return {
              value: {
                action: 'delegate',
                scope: 'edit',
                resolvedRequest: 'Extract existing script',
                task: 'Extract calculation bytes',
                acceptance: criteria,
                paths: ['site/index.html'],
              },
            };
          case 3:
            return { value: { action: 'blocked', blockedReason: 'File too large' } };
          default:
            assert.equal(input.roleState.role, 'primary');
            assert.equal(input.feedback.specialistBlock.reason, 'File too large');
            assert.equal(input.feedback.specialistBlock.attempt, 1);
            assert.ok(input.feedback.stagedPaths.includes('site/style.css'));
            return {
              value: {
                action: 'implement',
                files: [],
                textEdits: [
                  {
                    kind: 'extract',
                    path: 'site/index.html',
                    start: '<script>',
                    end: '</script>',
                    target: 'site/app.js',
                    replacement: '<script src="app.js"></script>',
                  },
                ],
              },
            };
        }
      },
      undefined,
      [],
      { check },
    );
    assert.ok(verified && result.commit);
    assert.deepEqual(await project.binary(result.commit, 'site/app.js'), Buffer.from(code));
    assert.equal((await project.files())['site/style.css'], 'body{color:blue}');
  }));
test('AI-16: invalid batch is repairable and leaves current candidate unchanged', () =>
  fixture(async (project, root) => {
    let calls = 0;
    const result = await workflow(
      project,
      slots,
      'Edit page',
      join(root, 'drafts'),
      () => {},
      async (_c, _i, input) => {
        if (++calls === 1)
          return {
            value: {
              action: 'implement',
              files: [],
              textEdits: [
                {
                  kind: 'replace',
                  path: 'site/index.html',
                  before: '<title>Nový web</title>',
                  after: '<title>First</title>',
                },
                { kind: 'replace', path: 'site/index.html', before: 'stale second', after: 'Second' },
              ],
            },
          };
        assert.match(input.files['site/index.html'], /Nový web/);
        assert.doesNotMatch(input.files['site/index.html'], /First/);
        assert.match(input.feedback.instruction, /unchanged/);
        return {
          value: {
            action: 'implement',
            files: [],
            textEdits: [
              {
                kind: 'replace',
                path: 'site/index.html',
                before: '<title>Nový web</title>',
                after: '<title>Changed</title>',
              },
            ],
          },
        };
      },
      undefined,
      [],
      { requestChecks: { technical: false, verification: false } },
    );
    assert.ok(result.commit);
    assert.match((await project.files())['site/index.html'], /<title>Changed/);
  }));
test('AI-16: specialist handbacks stop after two; lead blocked is terminal', () =>
  fixture(async (project, root) => {
    const head = await project.head();
    let calls = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Change page',
        join(root, 'drafts'),
        () => {},
        async (_c, _i, input) => {
          calls++;
          if (input.roleState.role === 'primary')
            return {
              value: {
                action: 'delegate',
                scope: 'edit',
                resolvedRequest: 'Change page',
                task: 'Bounded task',
                acceptance: criteria,
              },
            };
          return { value: { action: 'blocked', blockedReason: 'Real unavailable capability' } };
        },
        undefined,
        [],
        { check },
      ),
      /Real unavailable capability/,
    );
    assert.equal(calls, 6);
    assert.equal(await project.head(), head);
    calls = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Change page',
        join(root, 'drafts'),
        () => {},
        async () => {
          calls++;
          return { value: { action: 'blocked', blockedReason: 'Lead final block' } };
        },
        undefined,
        [],
        { check },
      ),
      /Lead final block/,
    );
    assert.equal(calls, 1);
  }));
test('AI-16: global 12 round limit remains after specialist handback', () =>
  fixture(async (project, root) => {
    let calls = 0;
    await assert.rejects(
      workflow(
        project,
        slots,
        'Change page',
        join(root, 'drafts'),
        () => {},
        async (_c, _i, input) => {
          calls++;
          if (calls === 1)
            return {
              value: {
                action: 'delegate',
                scope: 'edit',
                resolvedRequest: 'Change page',
                task: 'Bounded task',
                acceptance: criteria,
              },
            };
          if (calls === 2) return { value: { action: 'blocked', blockedReason: 'Hand back' } };
          return {
            value: { action: 'stage', files: [{ path: 'site/style.css', content: 'body{--round:' + calls + '}' }] },
          };
        },
        undefined,
        [],
        { check },
      ),
      /limit modelových/,
    );
    assert.equal(calls, 12);
  }));
test('AI-20: expanded targets still reject unsafe/binary/oversized paths before candidate/Git write', () =>
  fixture(async (project, root) => {
    const before = await project.head();
    for (const target of ['site/../settings.json', 'site/image.png', 'site/server.exe']) {
      await assert.rejects(
        workflow(
          project,
          slots,
          'Extract',
          join(root, 'drafts'),
          () => {},
          async () => ({
            value: {
              action: 'implement',
              files: [],
              textEdits: [
                {
                  kind: 'extract',
                  path: 'site/index.html',
                  start: '<head>',
                  end: '</head>',
                  target,
                  replacement: '<head></head>',
                },
              ],
            },
          }),
          undefined,
          [],
          { requestChecks: { technical: false, verification: false } },
        ),
      );
      assert.equal(await project.head(), before);
    }
    await assert.rejects(
      workflow(
        project,
        slots,
        'Expand',
        join(root, 'drafts'),
        () => {},
        async () => ({
          value: {
            action: 'implement',
            files: [],
            textEdits: [
              {
                kind: 'replace',
                path: 'site/index.html',
                before: '<title>Nový web</title>',
                after: 'x'.repeat(300001),
              },
            ],
          },
        }),
        undefined,
        [],
        { requestChecks: { technical: false, verification: false } },
      ),
      /textový soubor/,
    );
    assert.equal(await project.head(), before);
  }));

test('AI-16: automatically supplied architecture is observed for full-file and exact edits; unrelated unread files remain protected', () =>
  fixture(async (project, root) => {
    await project.write({ 'site/architecture.txt': 'Original architecture', 'site/unread.txt': 'Protected' });
    await project.commit('Architecture baseline');
    for (const exact of [false, true]) {
      const before = (await project.files())['site/architecture.txt'],
        after = before + ' updated';
      const result = await workflow(
        project,
        slots,
        'Update architecture',
        join(root, 'drafts'),
        () => {},
        async (_c, _i, input) => {
          assert.equal(input.files['site/architecture.txt'], before);
          return {
            value: exact
              ? {
                  action: 'implement',
                  files: [],
                  textEdits: [{ kind: 'replace', path: 'site/architecture.txt', before, after }],
                }
              : { action: 'implement', files: [{ path: 'site/architecture.txt', content: after }] },
          };
        },
        undefined,
        [],
        { requestChecks: { technical: false, verification: false } },
      );
      assert.ok(result.commit);
      assert.equal((await project.files())['site/architecture.txt'], after);
    }
    const head = await project.head();
    // A change to an unread file is rejected unchanged; the agent gets the file and redoes the change from it.
    const inputs: any[] = [];
    await workflow(
      project,
      slots,
      'Unread edit',
      join(root, 'drafts'),
      () => {},
      async (_c: any, _i: any, input: any) => {
        inputs.push(input);
        return inputs.length === 1
          ? { value: { action: 'implement', files: [{ path: 'site/unread.txt', content: 'Blind' }] } }
          : {
              value: {
                action: 'implement',
                files: [{ path: 'site/unread.txt', content: input.files['site/unread.txt'] + ' edited' }],
              },
            };
      },
      undefined,
      [],
      { requestChecks: { technical: false, verification: false } },
    );
    assert.match(inputs[1].feedback.instruction, /must be read before it is changed/);
    assert.notEqual(await project.head(), head);
    assert.equal((await project.files())['site/unread.txt'], 'Protected edited');
  }));
test('AI-16: empty existing architecture is supplied and observed before replacement', () =>
  fixture(async (project, root) => {
    await project.write({ 'site/architecture.txt': '' });
    await project.commit('Empty architecture');
    const result = await workflow(
      project,
      slots,
      'Describe actual architecture',
      join(root, 'drafts'),
      () => {},
      async (_c, _i, input) => {
        assert.ok(Object.hasOwn(input.files, 'site/architecture.txt'));
        assert.equal(input.files['site/architecture.txt'], '');
        return {
          value: {
            action: 'implement',
            files: [{ path: 'site/architecture.txt', content: 'site/index.html owns the initial page.' }],
          },
        };
      },
      undefined,
      [],
      { requestChecks: { technical: false, verification: false } },
    );
    assert.ok(result.commit);
    assert.equal((await project.files())['site/architecture.txt'], 'site/index.html owns the initial page.');
  }));
