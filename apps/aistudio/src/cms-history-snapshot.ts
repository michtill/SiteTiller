import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
export async function historyContentSnapshot(root: string, publishedLayout: boolean, cms: any) {
  const files: Record<string, string> = {},
    binary: Record<string, Buffer> = {},
    assets: Record<string, string> = {};
  let total = 0,
    count = 0;
  const walk = async (dir: string, ref: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Soubory obsahu nesmí být symbolické odkazy.');
      const path = join(dir, entry.name),
        relative = ref + entry.name;
      if (entry.isDirectory()) {
        await walk(path, relative + '/');
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (
        ![
          '.png',
          '.jpg',
          '.jpeg',
          '.webp',
          '.gif',
          '.avif',
          '.pdf',
          '.txt',
          '.doc',
          '.docx',
          '.xls',
          '.xlsx',
          '.odt',
          '.ods',
          '.ppt',
          '.pptx',
        ].includes(ext)
      )
        continue;
      const existing = cms.context.media.find((item: any) => item.source === relative && item.available);
      const bytes = existing ? cms.binary[existing.path] : await readFile(path);
      total += bytes.length;
      if (++count > 100 || total > 30 * 1024 * 1024) throw Error('Soubory obsahu překročily limit historie.');
      const target =
        existing?.path || 'site/cms/files/_snapshot/' + createHash('sha256').update(bytes).digest('hex') + ext;
      assets[relative] = target;
      if (!existing) {
        files[target] = ext === '.txt' ? bytes.toString('utf8') : '[Binary content asset]';
        binary[target] = bytes;
      }
    }
  };
  for (const folder of Object.keys(cms.context.schema.folders)) {
    const dir = join(root, publishedLayout ? 'files' : 'media', folder);
    try {
      if ((await lstat(dir)).isSymbolicLink()) throw Error('Složka obsahu nesmí být symbolický odkaz.');
      await walk(dir, folder + '/');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  files['site/cms/snapshot.json'] = JSON.stringify(
    { version: 1, source: cms.context.sourceMode || 'published', assets },
    null,
    2,
  );
  return { files, binary };
}
