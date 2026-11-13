import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, crc32 } from 'node:zlib';
import net from 'node:net';
import { bootstrapInstance } from '../scripts/instance-bootstrap.mjs';
import { exportFiles, exportName, exportSkips } from '../apps/shell/instance-export.ts';
const repo = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
// A ZIP read through its central directory, every entry inflated and its CRC checked.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
    count = buffer.readUInt16LE(end + 10),
    files = new Map();
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const crc = buffer.readUInt32LE(at + 16),
      compressed = buffer.readUInt32LE(at + 20),
      nameLength = buffer.readUInt16LE(at + 28),
      extra = buffer.readUInt16LE(at + 30),
      comment = buffer.readUInt16LE(at + 32),
      local = buffer.readUInt32LE(at + 42),
      name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28),
      content = inflateRawSync(buffer.subarray(start, start + compressed));
    assert.equal(crc32(content) >>> 0, crc, name);
    files.set(name, content);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
test('OP-12: Settings → Instance data downloads the whole instance as a ZIP after signing in; run-time files are left out', async () => {
  assert.equal(exportName('Modrý Kocour', new Date('2026-11-13T10:00:00Z')), 'modry-kocour-2026-11-13.zip');
  for (const path of ['logs/shell.log', 'processes.json', 'supervised.json', 'data/a.lock', 'x/node_modules/y'])
    assert.equal(exportSkips(path), true, path);
  for (const path of ['instance.json', 'settings/auth.json', '.sitetiller/master.key', '.production/repository.git/HEAD'])
    assert.equal(exportSkips(path), false, path);
  const base = await mkdtemp(join(tmpdir(), 'sitetiller-export-')),
    root = join(base, 'instance'),
    port = await freePort(),
    origin = 'http://127.0.0.1:' + port;
  let shell;
  try {
    await mkdir(root);
    await bootstrapInstance(repo, root, {
      ...process.env,
      SITETILLER_ADMIN_PASSWORD: 'fixture-password-12',
      SITETILLER_EDIT_ORIGIN: origin,
    });
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs/shell.log'), 'run-time');
    await writeFile(join(root, 'processes.json'), '{}');
    await mkdir(join(root, 'media/obrázky'), { recursive: true });
    await writeFile(join(root, 'media/obrázky/kočka.bin'), Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251)));
    shell = spawn(process.execPath, [join(repo, 'apps/shell/server.ts')], {
      cwd: repo,
      env: {
        ...process.env,
        PORT: String(port),
        EDIT_ORIGIN: origin,
        SITETILLER_INSTANCE_ROOT: root,
        SITETILLER_GATEWAY_TOKEN: 'g'.repeat(64),
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + '/login')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // Without signing in: the sign-in page, no ZIP.
    const anonymous = await fetch(origin + '/settings/data/download', { redirect: 'manual' });
    assert.equal(anonymous.status, 303);
    assert.match(anonymous.headers.get('location'), /^\/login/);
    const login = await fetch(origin + '/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=fixture-password-12',
        redirect: 'manual',
      }),
      cookie = login.headers.get('set-cookie').split(';')[0];
    // The screen in the side band, with the warning about its sensitive content.
    const screen = await (await fetch(origin + '/settings/data', { headers: { cookie } })).text();
    assert.match(screen, /href="\/settings\/data\?returnTo=[^"]*" aria-current="page"/);
    assert.match(screen, /action="\/settings\/data\/download"/);
    assert.match(screen, /(AI keys|AI klíče)/);
    const download = await fetch(origin + '/settings/data/download', { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.match(download.headers.get('content-disposition'), /attachment; filename="[a-z0-9.-]+-\d{4}-\d{2}-\d{2}\.zip"/);
    const files = unzip(Buffer.from(await download.arrayBuffer())),
      expected = await exportFiles(root);
    // Every file of the instance, byte for byte, without the run-time ones.
    assert.deepEqual([...files.keys()], expected);
    for (const name of expected) assert.deepEqual(files.get(name), await readFile(join(root, name)), name);
    for (const name of ['instance.json', 'settings/auth.json', 'settings/shared.json', 'media/obrázky/kočka.bin'])
      assert.ok(files.has(name), name);
    assert.ok([...files.keys()].some((name) => name.startsWith('.production/repository.git/')));
    assert.equal(files.has('logs/shell.log'), false);
    assert.equal(files.has('processes.json'), false);
  } finally {
    shell?.kill();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
