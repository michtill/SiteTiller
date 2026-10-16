import { readFile, writeFile, mkdir, rename, readdir, lstat, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { restoreRevision } from './design-restore.ts';
import { randomUUID, createHash } from 'node:crypto';
import { Store, Problem } from './store.ts';
import { fileDigest } from '../../../packages/content/file-digest.mjs';
import { linkOrCopy, linkTree, pruneNewest, atomicWrite, withFileLock } from '../../../packages/content/files.mjs';
// Release content: small JSON files as bytes, media as paths of existing files that are hard-linked, never copied into memory.
type Content = { buffers: Record<string, Buffer>; links: Record<string, string> };
const RELEASES_KEPT = 10;
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export class Publication {
  root: string;
  productionRoot: string;
  store: Store;
  constructor(
    root: string,
    store: Store,
    productionRoot = process.env.SITETILLER_PRODUCTION_ROOT || join(root, '.production'),
  ) {
    this.root = root;
    this.store = store;
    this.productionRoot = resolve(productionRoot);
  }
  async pointer() {
    try {
      return JSON.parse(await readFile(join(this.root, '.cms-publication/current.json'), 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async production() {
    try {
      return JSON.parse(await readFile(join(this.productionRoot, 'current.json'), 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async importProduction() {
    const source = await this.production();
    if (!source) return null;
    const base = join(source.directory, 'cms'),
      schema = JSON.parse(await readFile(join(base, 'structure.json'), 'utf8'));
    delete schema.settings;
    const content: Content = {
      buffers: { 'schema/structure.json': Buffer.from(JSON.stringify(schema, null, 2) + '\n') },
      links: {},
    };
    for (const name of Object.keys(schema.lists || {}))
      content.buffers['data/' + name + '.json'] = Buffer.from(
        JSON.stringify(JSON.parse(await readFile(join(base, 'data', name + '.json'), 'utf8')), null, 2) + '\n',
      );
    const walk = async (path: string, out: string) => {
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Problem(422, 'Symbolické odkazy nelze importovat.');
        if (item.isDirectory()) await walk(join(path, item.name), out + '/' + item.name);
        else if (item.isFile()) content.links[out + '/' + item.name] = join(path, item.name);
      }
    };
    for (const folder of Object.keys(schema.folders || {})) {
      try {
        await walk(join(base, 'files', folder), 'media/' + folder);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (JSON.stringify(await this.production()) !== JSON.stringify(source))
      throw new Problem(409, 'Produkce se během synchronizace změnila. Zkuste znovu.');
    return this.writeRelease(content, await this.contentDigest(content), {
      importedFromProduction: source.id,
      ...(typeof source.publishedAt === 'string' ? { publishedAt: source.publishedAt } : {}),
    });
  }
  async syncProduction() {
    const source = await this.production(),
      published = await this.pointer();
    if (!source) return published;
    // A published website without content (e.g. an older static site the instance continues) leaves it as it is.
    if (!(await exists(join(source.directory, 'cms', 'structure.json')))) return published;
    if (
      published?.importedFromProduction === source.id ||
      (published &&
        source.id === 'cms-' + published.id &&
        source.cmsPublication === published.id &&
        source.cmsRevision === published.revision)
    )
      return published;
    return this.importProduction();
  }
  async initialize() {
    return this.store.exclusive(() => this.syncProduction());
  }
  async writeRelease(content: Content, revision: string, extra: Record<string, unknown> = {}) {
    const id = randomUUID(),
      directory = join(this.root, '.cms-publication/releases', id);
    for (const [p, bytes] of Object.entries(content.buffers)) {
      const target = join(directory, p);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, bytes);
    }
    for (const [p, source] of Object.entries(content.links)) await linkOrCopy(source, join(directory, p));
    const published = { id, revision, directory, publishedAt: new Date().toISOString(), ...extra };
    await this.setPointer(published);
    return published;
  }
  async setPointer(published: any) {
    await mkdir(join(this.root, '.cms-publication'), { recursive: true });
    await atomicWrite(join(this.root, '.cms-publication/current.json'), JSON.stringify(published, null, 2) + '\n');
  }
  // The new production release shares every unchanged file with the previous one through hard links.
  async exportProduction(published: any, input: Content | Record<string, Buffer>) {
    const content: Content =
      (input as Content).buffers && (input as Content).links
        ? (input as Content)
        : { buffers: input as Record<string, Buffer>, links: {} };
    const old = await this.production();
    if (!old) return;
    const directory = join(this.productionRoot, 'releases', 'cms-' + published.id + '-' + randomUUID());
    await linkTree(old.directory, directory);
    await rm(join(directory, 'cms', 'data'), { recursive: true, force: true });
    await rm(join(directory, 'cms', 'files'), { recursive: true, force: true });
    const mapped = (p: string) =>
      join(
        directory,
        p === 'schema/structure.json'
          ? 'cms/structure.json'
          : p.startsWith('media/')
            ? 'cms/files/' + p.slice(6)
            : 'cms/' + p,
      );
    for (const [p, bytes] of Object.entries(content.buffers)) {
      const target = mapped(p);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, bytes);
    }
    for (const [p, source] of Object.entries(content.links)) await linkOrCopy(source, mapped(p)); // Publisher switches the same pointer; the check and the switch happen under their shared lock.
    const target = join(this.productionRoot, 'current.json');
    try {
      await withFileLock(target, async () => {
        if (JSON.stringify(await this.production()) !== JSON.stringify(old))
          throw new Problem(409, 'Produkce se během publikování změnila. Zkuste publikovat znovu.');
        await atomicWrite(
          target,
          JSON.stringify(
            {
              ...old,
              id: 'cms-' + published.id,
              directory,
              cmsPublication: published.id,
              cmsRevision: published.revision,
              publishedAt: published.publishedAt,
            },
            null,
            2,
          ) + '\n',
        );
      });
    } catch (e: any) {
      if (e.code === 'ELOCKED') throw new Problem(409, 'Probíhá publikování webu. Zkuste to za chvíli znovu.');
      throw e;
    }
  }
  // Retention: the current release and the ten newest previous ones stay in both release folders.
  async pruneReleases() {
    await pruneNewest(join(this.root, '.cms-publication/releases'), {
      keep: RELEASES_KEPT,
      protect: [(await this.pointer())?.directory],
    });
    await pruneNewest(join(this.productionRoot, 'releases'), {
      keep: RELEASES_KEPT,
      protect: [(await this.production())?.directory],
      filter: (name) => !name.startsWith('.'),
    });
  }
  async files() {
    const schema = await this.store.schema();
    const files: Record<string, Buffer> = {
      'schema/structure.json': Buffer.from(JSON.stringify(schema, null, 2) + '\n'),
    };
    for (const name of Object.keys(schema.lists))
      files['data/' + name + '.json'] = Buffer.from(
        JSON.stringify((await this.store.snapshot(name)).rows, null, 2) + '\n',
      );
    const walk = async (path: string) => {
      for (const item of await readdir(join(this.root, path), { withFileTypes: true })) {
        const p = path + '/' + item.name;
        if (item.isSymbolicLink()) throw new Problem(422, 'Symbolické odkazy nelze publikovat.');
        if (item.isDirectory()) await walk(p);
        else if (item.isFile()) files[p] = await readFile(join(this.root, p));
      }
    };
    for (const folder of Object.keys(schema.folders || {})) {
      try {
        await walk('media/' + folder);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return files;
  }
  digest(files: Record<string, Buffer>) {
    const digests: Record<string, Buffer> = {};
    for (const p of Object.keys(files)) digests[p] = createHash('sha256').update(files[p]).digest();
    return this.combine(digests);
  }
  combine(digests: Record<string, Buffer>) {
    const hash = createHash('sha256');
    for (const p of Object.keys(digests).sort()) {
      hash.update(p + '\0');
      hash.update(digests[p]);
    }
    return hash.digest('hex');
  }
  async workingContent(): Promise<Content> {
    const schema = await this.store.schema();
    const content: Content = {
      buffers: { 'schema/structure.json': Buffer.from(JSON.stringify(schema, null, 2) + '\n') },
      links: {},
    };
    for (const name of Object.keys(schema.lists))
      content.buffers['data/' + name + '.json'] = Buffer.from(
        JSON.stringify((await this.store.snapshot(name)).rows, null, 2) + '\n',
      );
    const walk = async (path: string) => {
      for (const item of await readdir(join(this.root, path), { withFileTypes: true })) {
        const p = path + '/' + item.name;
        if (item.isSymbolicLink()) throw new Problem(422, 'Symbolické odkazy nelze publikovat.');
        if (item.isDirectory()) await walk(p);
        else if (item.isFile()) content.links[p] = join(this.root, p);
      }
    };
    for (const folder of Object.keys(schema.folders || {})) {
      try {
        await walk('media/' + folder);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return content;
  }
  async contentDigest(content: Content) {
    const digests: Record<string, Buffer> = {};
    for (const [p, bytes] of Object.entries(content.buffers)) digests[p] = createHash('sha256').update(bytes).digest();
    for (const [p, source] of Object.entries(content.links)) digests[p] = await fileDigest(source);
    return this.combine(digests);
  }
  // Same value as digest(files()), but media bytes are hashed only when a file changed.
  async workingDigest() {
    return this.contentDigest(await this.workingContent());
  }
  async status() {
    return this.store.exclusive(async () => {
      const p = await this.syncProduction();
      return { published: p, unpublished: !p || p.revision !== (await this.workingDigest()) };
    });
  }
  publish(guard?: () => Promise<boolean>, expectedRevision?: string) {
    return this.store.exclusive(async () => {
      if (expectedRevision !== undefined && expectedRevision !== (await restoreRevision(this.root)))
        throw new Problem(409, 'Pracovní obsah se mezitím změnil. Znovu otevřete publikování.');
      if (guard && !(await guard())) {
        const published = await this.syncProduction();
        return { published, unpublished: !published || published.revision !== (await this.workingDigest()) };
      }
      const content = await this.workingContent(),
        revision = await this.contentDigest(content),
        old = await this.syncProduction();
      if (old?.revision === revision) {
        if ((await this.production())?.cmsRevision !== revision) await this.exportProduction(old, content);
        await this.pruneReleases();
        return { published: old, unpublished: false };
      }
      const previous = old,
        published = await this.writeRelease(content, revision);
      try {
        await this.exportProduction(published, content);
      } catch (e) {
        if (previous) await this.setPointer(previous);
        else await rm(join(this.root, '.cms-publication/current.json'), { force: true });
        throw e;
      }
      await this.pruneReleases();
      return { published, unpublished: false };
    });
  }
  async asset(path: string) {
    const p = await this.store.exclusive(() => this.syncProduction());
    if (!p) throw new Problem(404, 'Obsah ještě nebyl publikován.');
    const parts = path.split('/');
    if (
      parts.some((x) => !x || x === '.' || x === '..' || /[\\:\x00-\x1f]/.test(x)) ||
      !['schema', 'data', 'media'].includes(parts[0])
    )
      throw new Problem(404, 'Soubor nenalezen.');
    let target = p.directory;
    for (const part of parts) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Problem(404, 'Soubor nenalezen.');
    }
    return { bytes: await readFile(target), path: target };
  }
}
