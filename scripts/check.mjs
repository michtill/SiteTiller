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
// A recommendation file changes only with a higher revision (documentation 4.6): instances take a downloaded file
// only when its revision is higher, so a change under the same revision would never reach them. Checked against the file's last
// committed versions (an uncommitted change against the last commit, the last commit against the one before).
for (const file of ['packages/models/recommended-sets.json']) {
  const git = (...args) => spawnSync('git', args, { windowsHide: true, encoding: 'utf8' });
  const commits = git('log', '-n', '2', '--format=%H', '--', file).stdout.split('\n').filter(Boolean),
    versions = [await readFile(file, 'utf8'), ...commits.map((c) => git('show', c + ':' + file).stdout)].filter(
      (text, i, all) => text && (i === 0 || text !== all[i - 1]),
    );
  for (let i = 0; i + 1 < Math.min(versions.length, 3); i++) {
    const [newer, older] = [versions[i], versions[i + 1]].map((text) => JSON.parse(text)),
      content = (value) => JSON.stringify({ ...value, date: '', revision: 0 });
    if (content(newer) !== content(older) && !((newer.revision || 0) > (older.revision || 0))) {
      console.error(
        file +
          ': the content changed but the revision ' +
          newer.revision +
          ' is not higher than ' +
          older.revision +
          '.',
      );
      process.exitCode = 1;
    }
  }
}
console.log('Recommendation revisions checked.');
// The editor's colours are only the --ui-* variables of packages/ui/colors.css (documentation 2.4): a fixed colour in
// another stylesheet would not follow the Light and Dark colour modes.
const fixedColour = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(white|black)\b(?!-)|rgba?\(/;
for (const file of [
  'apps/cmstudio/editor/style.css',
  'apps/aistudio/ui/style.css',
  'apps/shell/shell.css',
  ...(await readdir('packages/ui'))
    .filter((f) => f.endsWith('.css') && f !== 'colors.css')
    .map((f) => 'packages/ui/' + f),
]) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (fixedColour.test(line.replace(/\/\*.*?\*\//g, ''))) {
      console.error(file + ':' + (i + 1) + ': a fixed colour; use a --ui-* variable of packages/ui/colors.css.');
      process.exitCode = 1;
    }
  });
}
console.log('Colours checked.');
