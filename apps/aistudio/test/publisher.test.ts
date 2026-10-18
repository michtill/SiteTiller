import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Project } from '../src/project.ts';
const exec = promisify(execFile);
test('PU-01: publisher rejects missing auth and stale commits; pushes reviewed explicit SHA to a disposable Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-publisher-test-'));
  let child: any;
  try {
    const data = join(root, 'data');
    const project = new Project(join(data, 'project'));
    await project.init(fileURLToPath(new URL('../seed', import.meta.url)));
    const base = await project.head();
    const files = await project.files();
    await project.write({ 'site/style.css': files['site/style.css'] + '\n/* publisher-test */' });
    const commit = await project.commit('Publish test');
    await project.write({ 'site/index.html': 'invalid later draft' });
    const newer = await project.commit('Later draft');
    await writeFile(join(data, 'publish-approval.json'), JSON.stringify({ commit, head: newer, intent: null }));
    const target = join(root, 'production.git');
    await exec('git', ['clone', '--bare', project.root, target]);
    await exec('git', ['--git-dir=' + target, 'update-ref', 'refs/heads/main', base]);
    const port = 18140 + Math.floor(Math.random() * 30),
      url = `http://127.0.0.1:${port}/publish`;
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/publisher.ts', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        SITETILLER_DATA_DIR: data,
        SITETILLER_PRODUCTION_GIT: target,
        SITETILLER_PUBLISH_TOKEN: 'test-token',
        SITETILLER_PRODUCTION_URL: '',
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(url)).status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(ready, 'publisher must start');
    const request = (sha: string) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: sha }),
      });
    assert.equal((await request(base)).status, 409);
    const response = await request(commit);
    assert.equal(response.status, 200, await response.text());
    const { stdout } = await exec('git', ['--git-dir=' + target, 'rev-parse', 'main']);
    assert.notEqual(stdout.trim(), commit);
    assert.equal(
      (await exec('git', ['--git-dir=' + target, 'rev-parse', 'main:site'])).stdout.trim(),
      await project.git(['rev-parse', commit + ':site']),
    );
    assert.equal(await project.head(), newer);
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await rm(root, { recursive: true, force: true });
  }
});
test('PU-11: with a remote production Git the publisher pushes the publication and its release tag there and keeps a mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-publisher-remote-'));
  let child: any;
  try {
    const data = join(root, 'data');
    const project = new Project(join(data, 'project'));
    await project.init(fileURLToPath(new URL('../seed', import.meta.url)));
    const base = await project.head();
    const files = await project.files();
    await project.write({ 'site/style.css': files['site/style.css'] + '\n/* remote */' });
    const commit = await project.commit('Publish remote');
    await writeFile(join(data, 'publish-approval.json'), JSON.stringify({ commit, head: commit, intent: null }));
    // The remote stands in for ssh://…: any Git address works the same way.
    const remote = join(root, 'remote.git'),
      mirror = join(root, 'instance', '.production', 'remote.git');
    await exec('git', ['clone', '--bare', project.root, remote]);
    await exec('git', ['--git-dir=' + remote, 'update-ref', 'refs/heads/main', base]);
    const port = 18180 + Math.floor(Math.random() * 30),
      url = `http://127.0.0.1:${port}/publish`;
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/publisher.ts', import.meta.url))], {
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        SITETILLER_DATA_DIR: data,
        SITETILLER_PRODUCTION_REMOTE: remote,
        SITETILLER_PRODUCTION_GIT: mirror,
        SITETILLER_PUBLISH_TOKEN: 'test-token',
        SITETILLER_PRODUCTION_URL: '',
      },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(url)).status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(ready, 'publisher must start');
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit }),
    });
    assert.equal(response.status, 200, await response.text());
    const remoteMain = (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim();
    assert.equal(
      (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main:site'])).stdout.trim(),
      await project.git(['rev-parse', commit + ':site']),
    );
    for (const git of [remote, mirror]) {
      assert.equal(
        (await exec('git', ['--git-dir=' + git, 'tag', '--list', 'sitetiller/published/*'])).stdout.trim(),
        'sitetiller/published/v1',
      );
      assert.equal((await exec('git', ['--git-dir=' + git, 'rev-parse', 'main'])).stdout.trim(), remoteMain);
    }
  } finally {
    if (child) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await rm(root, { recursive: true, force: true });
  }
});
