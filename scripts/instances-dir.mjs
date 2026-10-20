// Where the local instances (Playground and others) live: SITETILLER_INSTANCES, else "instances" in the
// untracked file .sitetiller-local.json at the repository root, else the folder sitetiller-instances in the user's
// home directory. A machine's own paths stay in that local file, never in the repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function instancesDirectory() {
  if (process.env.SITETILLER_INSTANCES) return resolve(process.env.SITETILLER_INSTANCES);
  try {
    const local = JSON.parse(
      readFileSync(fileURLToPath(new URL('../.sitetiller-local.json', import.meta.url)), 'utf8'),
    );
    if (typeof local.instances === 'string' && local.instances) return resolve(local.instances);
  } catch {}
  return join(homedir(), 'sitetiller-instances');
}
