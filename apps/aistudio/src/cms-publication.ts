import { historyContentSnapshot } from './cms-history-snapshot.ts';
import { tmpdir } from 'node:os';
import { cmsSource } from './cms-source.ts';
import { readdir, readFile, lstat, mkdir, writeFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from './project.ts';
export async function cmsContentDirty(project: Project, root: string) {
  const files = await project.committedFiles(await project.head()),
    schema = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
  delete schema.settings;
  try {
    if (JSON.stringify(schema) !== JSON.stringify(JSON.parse(files['site/cms/structure.json'] || 'null'))) return true;
    for (const name of Object.keys(schema.lists)) {
      if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw Error('Invalid CMS collection');
      const live = JSON.parse(
        await readFile(join(root, 'data', name + '.json'), 'utf8').catch((e: any) => {
          if (e.code === 'ENOENT') return '[]';
          throw e;
        }),
      );
      if (JSON.stringify(live) !== JSON.stringify(JSON.parse(files['site/cms/data/' + name + '.json'] || 'null')))
        return true;
    }
    return false;
  } catch {
    return true;
  }
}
export async function captureCmsPublication(project: Project, root: string, publishedLayout = false) {
  const before = await project.head(),
    cms = await cmsSource(root, publishedLayout);
  if (!cms) throw Error('CMS is missing');
  const previous = await project.files();
  for (const name of Object.keys(previous)) if (name.startsWith('site/cms/')) delete previous[name];
  const snapshot = await historyContentSnapshot(root, publishedLayout, cms);
  const files = { ...previous, ...cms.files, ...snapshot.files },
    binary = { ...cms.binary, ...snapshot.binary };
  const walk = async (dir: string, ref: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Media symlinks are forbidden');
      const path = join(dir, entry.name),
        name = ref + entry.name;
      if (entry.isDirectory()) await walk(path, name + '/');
      else {
        files['site/cms/files/' + name] = '[Binary image asset]';
        binary['site/cms/files/' + name] = await readFile(path);
      }
    }
  };
  for (const folder of Object.keys(cms.context.schema.folders)) {
    try {
      const path = join(root, publishedLayout ? 'files' : 'media', folder);
      if ((await lstat(path)).isSymbolicLink()) throw Error('Media symlinks are forbidden');
      await walk(path, folder + '/');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  await project.writeSnapshot(files);
  for (const [path, bytes] of Object.entries(binary)) {
    await mkdir(join(project.root, path, '..'), { recursive: true });
    await writeFile(join(project.root, path), bytes);
  }
  const commit = await project.commit('SiteTiller: freeze CMS content and files for publication');
  return { before, commit };
}

export async function capturePublicationSource(
  project: Project,
  commit: string,
  head: string,
  root: string,
  publishedLayout = false,
) {
  if (commit === head) {
    const captured = await captureCmsPublication(project, root, publishedLayout);
    return {
      commit: captured.commit,
      head: captured.commit,
      mapping: captured.commit === head ? {} : { [head]: captured.commit },
    };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'sitetiller-cms-publication-'));
  try {
    await cp(project.root, temporary, { recursive: true });
    const draft = new Project(temporary);
    await draft.git(['checkout', '--detach', commit]);
    const captured = await captureCmsPublication(draft, root, publishedLayout);
    if (captured.commit === commit) return { commit, head, mapping: {} };
    const mapping: Record<string, string> = { [commit]: captured.commit };
    let tip = captured.commit;
    for (const original of (await project.git(['rev-list', '--first-parent', '--reverse', commit + '..' + head]))
      .split('\n')
      .filter(Boolean)) {
      tip = await draft.git([
        'commit-tree',
        await project.git(['rev-parse', original + '^{tree}']),
        '-p',
        tip,
        '-m',
        await project.git(['show', '-s', '--format=%s', original]),
      ]);
      mapping[original] = tip;
    }
    await draft.git(['checkout', '-B', 'main', tip]);
    if ((await project.head()) !== head || (await project.git(['status', '--porcelain', '--untracked-files=no'])))
      throw Error('Návrh se během přípravy publikace změnil.');
    await project.git(['fetch', temporary, 'main']);
    await project.git(['update-ref', 'refs/sitetiller/pre-cms-publication/' + Date.now(), head]);
    await project.git(['update-ref', 'refs/heads/main', tip, head]);
    await project.git(['reset', '--hard', tip]);
    return { commit: captured.commit, head: tip, mapping };
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
