import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Project } from '../src/project.ts';
import { initialTeam, initialImages } from '../src/team.ts';
const gateway = 'fixture-gateway-token';
test('HI-10: saving a draft can make the saved step the first step; unchecked, the steps stay', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sitetiller-save-clear-'));
  let child: any;
  try {
    const project = new Project(join(data, 'project'));
    await project.init(null);
    const commits: string[] = [];
    for (const name of ['Published', 'One', 'Two', 'Three']) {
      await project.write({ 'site/index.html': '<!doctype html><title>' + name + '</title><h1>' + name + '</h1>' });
      commits.push(await project.commit(name));
    }
    const [published, one, two, head] = commits,
      at = (minute: number) => '2026-10-05T12:0' + minute + ':00.000Z';
    await writeFile(
      join(data, 'events.json'),
      JSON.stringify([
        { jobId: 'publication', kind: 'publish', stage: 'published', commit: published, at: at(1) },
        { jobId: 'one', stage: 'request', message: 'First edit', at: at(2) },
        { jobId: 'one', stage: 'ready', commit: one, at: at(2) },
        { jobId: 'two', stage: 'request', message: 'Second edit', at: at(3) },
        { jobId: 'two', stage: 'ready', commit: two, at: at(3) },
        { jobId: 'three', stage: 'request', message: 'Third edit', at: at(4) },
        { jobId: 'three', stage: 'ready', commit: head, at: at(4) },
      ]),
    );
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        providers: { openai: { key: '' }, anthropic: { key: '' } },
        roles: initialTeam(),
        imageModels: initialImages(),
        agentArchitecture: 3,
        automaticReasoningPolicy: 1,
        publishedCommit: published,
        publishedThrough: 0,
        draftBaseCommit: published,
        requests: [
          {
            id: 'one',
            prompt: 'First edit',
            baseCommit: published,
            commit: one,
            status: 'ready',
            sequence: 1,
            createdAt: at(2),
          },
          {
            id: 'two',
            prompt: 'Second edit',
            baseCommit: one,
            commit: two,
            status: 'ready',
            sequence: 2,
            createdAt: at(3),
          },
          {
            id: 'three',
            prompt: 'Third edit',
            baseCommit: two,
            commit: head,
            status: 'ready',
            sequence: 3,
            createdAt: at(4),
          },
        ],
      }),
    );
    const port = 22400 + Math.floor(Math.random() * 100),
      origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        SITETILLER_GATEWAY_TOKEN: gateway,
        SITETILLER_SHARED_AUTH_FILE: '',
        SITETILLER_CMS_ROOT: '',
        SITETILLER_PUBLISH_URL: '',
        SITETILLER_DATA_DIR: data,
        SITETILLER_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await fetch(origin + '/health')).ok;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const post = (path: string, input: any) =>
      fetch(origin + '/api/' + path, {
        method: 'POST',
        headers: { Origin: origin, 'x-sitetiller-gateway': gateway, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    const state = async () =>
      (await (await fetch(origin + '/api/state', { headers: { 'x-sitetiller-gateway': gateway } })).json()) as any;
    const ids = async () => (await state()).requests.map((r: any) => r.id);
    // Unchecked: the steps do not change.
    assert.equal(
      (await post('drafts/save', { name: 'Kept', expectedHead: head, commit: two, clearPrevious: false })).status,
      200,
    );
    assert.deepEqual(await ids(), ['one', 'two', 'three']);
    assert.equal(
      (await post('drafts/save', { name: 'Bad', expectedHead: head, commit: two, clearPrevious: 'yes' })).status,
      422,
    );
    // Checked: the saved step and those before it are replaced by a new first step "Saved draft Second" with the
    // same state (documentation 4.9); later steps stay.
    const saved = await post('drafts/save', { name: 'Second', expectedHead: head, commit: two, clearPrevious: true });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).draft.step, two);
    const after = await state();
    assert.deepEqual(
      after.requests.map((r: any) => [r.firstStep || r.id, r.savedDraftName || r.prompt, r.commit]),
      [
        ['saved', 'Second', two],
        ['three', 'Third edit', head],
      ],
    );
    assert.equal(after.head, head);
    assert.deepEqual([...new Set(after.events.map((e: any) => e.jobId))], ['three']);
    assert.equal(after.requests[0].presentationChanged, true);
    assert.deepEqual(
      after.savedDrafts.map((d: any) => [d.name, d.step]),
      [
        ['Kept', two],
        ['Second', two],
      ],
    );
    // The removed steps are discarded: the agents do not remember them.
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
    assert.equal(config.draftBaseCommit, one);
    assert.deepEqual(
      config.conversationMemory,
      [],
    );
  } finally {
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
