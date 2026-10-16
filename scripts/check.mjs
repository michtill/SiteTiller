import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots = ['apps/aistudio/src', 'apps/shell', 'apps/website', 'packages', 'scripts'];
let checked = 0;
async function walk(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) await walk(path);
    else if (/\.(ts|mjs|js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { windowsHide: true, encoding: 'utf8' });
      if (result.status) {
        process.stderr.write(result.stderr);
        process.exitCode = 1;
      }
      checked++;
    }
  }
}
for (const root of roots) await walk(root);
console.log('Syntax checked ' + checked + ' source files.');
// Every test verifies a scenario of the documentation (chapter 13) and starts its title with that ID.
const testRoots = ['apps', 'test', 'packages', 'scripts'],
  skip = new Set(['node_modules', 'dist', 'work']),
  missing = [];
let tests = 0;
async function walkTests(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) {
      if (!skip.has(item.name)) await walkTests(path);
    } else if (/\.test\.(ts|mjs|js)$/.test(item.name)) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const title = /\btest\(\s*$/.test(line)
          ? /^\s*(['"`])(.*)/.exec(lines[i + 1] || '')
          : /\btest\(\s*(['"`])(.*)/.exec(line);
        if (!title) return;
        tests++;
        if (!/^[A-Z0-9]+-\d+: /.test(title[2])) missing.push(path + ':' + (i + 1));
      });
    }
  }
}
for (const root of testRoots) await walkTests(root);
if (missing.length) {
  console.error('Tests without a scenario ID (documentation chapter 13):\n' + missing.join('\n'));
  process.exitCode = 1;
}
console.log('Scenario IDs checked in ' + tests + ' tests.');
