import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Problem } from './store.ts';
// The Content Editor has no settings of its own: name, theme and the default edit mode come from the Shared settings.
export class SettingsStore {
  sharedFile: string;
  constructor(root: string, options: { sharedFile?: string } = {}) {
    this.sharedFile = options.sharedFile || join(root, 'settings/shared.json');
  }
  private async shared() {
    try {
      return JSON.parse(await readFile(this.sharedFile, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { name: 'SiteTiller', theme: 'green' };
    }
  }
  async snapshot() {
    const shared = await this.shared();
    if (
      !shared ||
      typeof shared.name !== 'string' ||
      !shared.name.trim() ||
      !['green', 'blue', 'plum', 'graphite', 'sand', 'black', 'light'].includes(shared.theme)
    )
      throw new Problem(422, 'Neplatné společné nastavení.');
    return { settings: { name: shared.name, theme: shared.theme } };
  }
  // Whether the Editor starts in live editing (only applied when there are no unpublished changes).
  async liveByDefault() {
    return (await this.shared())?.contentDefault === 'live';
  }
}
