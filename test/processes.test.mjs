import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execHidden, spawnHidden, stopOwnedChild, windowsProcesses } from '../scripts/processes.mjs';
test(
  'OP-04: hidden Windows helpers and tracked child cleanup include descendants',
  { skip: process.platform !== 'win32', timeout: 20000 },
  async () => {
    const { stdout } = await execHidden(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output fixture-ok'],
      { timeout: 10000 },
    );
    assert.equal(stdout.trim(), 'fixture-ok');
    const code =
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','next-owned-process-fixture'],{windowsHide:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)";
    const child = spawnHidden(process.execPath, ['-e', code, 'next-owned-process-fixture'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let descendant;
    try {
      descendant = await new Promise((resolve, reject) => {
        child.stdout.once('data', (data) => resolve(Number(data.toString().trim())));
        child.once('error', reject);
      });
      assert.ok(Number.isInteger(descendant));
      const before = await windowsProcesses([child.pid, descendant]);
      assert.equal(before.length, 2);
      assert.ok(before.every((p) => p.command.includes('next-owned-process-fixture')));
      await stopOwnedChild(child);
      assert.deepEqual(await windowsProcesses([child.pid, descendant]), []);
    } finally {
      await stopOwnedChild(child);
    }
  },
);
