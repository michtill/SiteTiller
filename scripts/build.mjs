// Builds the browser apps: the Content editor (apps/cmstudio/dist) and AI Studio (apps/aistudio/dist).
// The Content editor has its own installation; AI Studio uses the one at the repository root.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url));
for (const [cwd, vite, args] of [
  ['apps/cmstudio', 'apps/cmstudio/node_modules/vite/bin/vite.js', ['build']],
  ['apps/aistudio', 'node_modules/vite/bin/vite.js', ['build', '-c', 'vite.config.mjs']],
]) {
  const result = spawnSync(process.execPath, [repo + vite, ...args], {
    cwd: repo + cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
