import { raster, binaryAsset } from './images.ts';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, lstat, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { safeSitePath, validateFiles } from './core.ts';
import { staticChecks } from './checks.ts';
const exec = promisify(execFile);
// Commits never change, so their file trees and blobs are cached per process.
const SNAPSHOT_LIMIT = 50,
  BINARY_BYTES_LIMIT = 200 * 1024 * 1024,
  READER_IDLE_MS = 500;
type Waiter = { resolve: (value: Buffer | null) => void; reject: (error: Error) => void };
export class Project {
  root: string;
  private objectReader: boolean;
  private snapshotCache = new Map<string, Promise<Record<string, string>>>();
  private binaryCache = new Map<string, Buffer>();
  private binaryBytes = 0;
  private reader: {
    child: ChildProcess;
    pending: Waiter[];
    buffer: Buffer;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;

  // objectReader: long-lived repositories (draft, production) read objects through one `git cat-file --batch`
  // process. It holds files open, so it closes after a short idle time and is never used for temporary copies,
  // which must stay deletable on Windows.
  constructor(root: string, options: { objectReader?: boolean } = {}) {
    this.root = root;
    this.objectReader = !!options.objectReader;
  }
  private async readObject(spec: string): Promise<Buffer | null> {
    if (/[\r\n]/.test(spec)) throw Error('Neplatný objekt.');
    if (!this.objectReader) {
      try {
        const { stdout } = await exec('git', ['-c', 'safe.directory=' + this.root, 'cat-file', '-p', spec], {
          cwd: this.root,
          windowsHide: true,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return null;
      }
    }
    if (!this.reader) {
      const gitDir = existsSync(join(this.root, '.git')) ? join(this.root, '.git') : this.root;
      const child = spawn(
        'git',
        [
          '-c',
          'safe.directory=' + this.root,
          '-c',
          'safe.directory=' + gitDir,
          '--git-dir',
          gitDir,
          'cat-file',
          '--batch',
        ],
        { cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const reader = { child, pending: [] as Waiter[], buffer: Buffer.alloc(0) } as NonNullable<typeof this.reader>;
      this.reader = reader;
      const fail = (error: Error) => {
        clearTimeout(reader.timer);
        if (this.reader === reader) this.reader = null;
        for (const waiter of reader.pending.splice(0)) waiter.reject(error);
      };
      child.on('error', fail);
      child.on('exit', () => fail(Error('Čtení verze bylo přerušeno.')));
      child.stdin!.on('error', () => {});
      child.stdout!.on('data', (chunk: Buffer) => {
        reader.buffer = Buffer.concat([reader.buffer, chunk]);
        while (reader.pending.length) {
          const lineEnd = reader.buffer.indexOf(10);
          if (lineEnd < 0) return;
          const header = reader.buffer.subarray(0, lineEnd).toString('utf8');
          if (/ (missing|ambiguous)$/.test(header)) {
            reader.buffer = reader.buffer.subarray(lineEnd + 1);
            reader.pending.shift()!.resolve(null);
            continue;
          }
          const size = Number(header.split(' ')[2]);
          if (!Number.isInteger(size)) {
            fail(Error('Neplatná odpověď gitu.'));
            child.kill();
            return;
          }
          if (reader.buffer.length < lineEnd + 1 + size + 1) return;
          const body = Buffer.from(reader.buffer.subarray(lineEnd + 1, lineEnd + 1 + size));
          reader.buffer = reader.buffer.subarray(lineEnd + 1 + size + 1);
          reader.pending.shift()!.resolve(body);
        }
        // Idle: release open repository files soon and never keep this process alive.
        if (!reader.pending.length) {
          reader.timer = setTimeout(() => {
            if (this.reader === reader && !reader.pending.length) {
              this.reader = null;
              child.stdin!.end();
            }
          }, READER_IDLE_MS);
          reader.timer.unref();
        }
      });
    }
    const reader = this.reader;
    clearTimeout(reader.timer);
    return new Promise((resolve, reject) => {
      reader.pending.push({ resolve, reject });
      reader.child.stdin!.write(spec + '\n');
    });
  }
  // Tree id of a directory in a commit. A full commit id never changes, so its trees are kept in memory;
  // the studio state asks for them on every refresh.
  private trees = new Map<string, string>();
  async tree(commit: string, path = 'site') {
    const key = commit + ':' + path,
      fixed = /^[a-f0-9]{40}$/.test(commit),
      hit = fixed ? this.trees.get(key) : undefined;
    if (hit) return hit;
    const value = await this.git(['rev-parse', key]);
    if (fixed) {
      if (this.trees.size >= 1000) this.trees.clear();
      this.trees.set(key, value);
    }
    return value;
  }
  async git(args: string[]) {
    const started = Date.now();
    if (process.env.SITETILLER_GIT_TRACE === '1') console.error('git:start ' + args[0]);
    const { stdout } = await exec(
      'git',
      ['-c', 'safe.directory=' + this.root, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      { cwd: this.root, windowsHide: true, timeout: 30000, maxBuffer: 2000000 },
    );
    if (process.env.SITETILLER_GIT_TRACE === '1')
      console.error('git:done ' + args[0] + ' ' + (Date.now() - started) + 'ms');
    return stdout.trim();
  }
  async init(seed: string | null) {
    await mkdir(this.root, { recursive: true });
    try {
      await lstat(join(this.root, '.git'));
    } catch {
      if (seed === null) {
        await this.git(['init', '-b', 'main']);
        await this.write({
          'site/index.html':
            '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nový web</title></head><body><main><h1>Nový web</h1><p>Vytvořte web zadáním požadavku v SiteTiller.</p></main></body></html>',
        });
      } else
        try {
          await lstat(join(seed, '..', 'seed.bundle'));
          await this.git(['-c', 'core.autocrlf=false', 'clone', '-b', 'main', join(seed, '..', 'seed.bundle'), '.']);
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
          await cp(seed, this.root, { recursive: true });
          await this.git(['init', '-b', 'main']);
        }
      await this.git(['config', 'core.autocrlf', 'false']);
      await this.git(['config', 'user.name', 'SiteTiller']);
      await this.git(['config', 'user.email', 'sitetiller@localhost']);
      await this.git(['add', '.']);
      if (await this.git(['status', '--porcelain'])) await this.git(['commit', '-m', 'Import existing website']);
    }
  }
  async files() {
    const result: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const ent of await readdir(join(this.root, dir), { withFileTypes: true })) {
        if (ent.isSymbolicLink()) throw new Error('Symbolické odkazy nejsou povolené.');
        const name = dir + '/' + ent.name;
        if (ent.isDirectory()) await walk(name);
        else {
          safeSitePath(this.root, name);
          result[name] = binaryAsset(name) ? '[Binary image asset]' : await readFile(join(this.root, name), 'utf8');
        }
      }
    };
    try {
      await walk('site');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    return result;
  }
  async write(files: Record<string, string>) {
    for (const [name, text] of Object.entries(files)) {
      const path = safeSitePath(this.root, name);
      if (binaryAsset(name)) continue;
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text);
    }
  }
  async writeSnapshot(files: Record<string, string>) {
    for (const name of Object.keys(files)) safeSitePath(this.root, name);
    const current = await this.files();
    // Remove individual validated site files in the isolated draft; never remove the repository.
    for (const name of Object.keys(current)) if (!Object.hasOwn(files, name)) await rm(safeSitePath(this.root, name));
    await this.write(files);
  }
  async binary(commit: string, name: string) {
    safeSitePath(this.root, name);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Neplatný commit.');
    const key = commit + '\0' + name,
      hit = this.binaryCache.get(key);
    if (hit) {
      this.binaryCache.delete(key);
      this.binaryCache.set(key, hit);
      return hit;
    }
    const bytes = await this.readObject(commit + ':' + name);
    if (!bytes) throw Error('Soubor ' + name + ' ve verzi neexistuje.');
    if (bytes.length <= BINARY_BYTES_LIMIT / 4) {
      this.binaryCache.set(key, bytes);
      this.binaryBytes += bytes.length;
      for (const [old, value] of this.binaryCache) {
        if (this.binaryBytes <= BINARY_BYTES_LIMIT) break;
        this.binaryCache.delete(old);
        this.binaryBytes -= value.length;
      }
    }
    return bytes;
  }
  // Reads the ref files directly (no process); falls back to git for unusual layouts.
  async head() {
    try {
      const git = join(this.root, '.git'),
        text = (await readFile(join(git, 'HEAD'), 'utf8')).trim();
      if (/^[a-f0-9]{40}$/.test(text)) return text;
      const ref = text.match(/^ref: (refs\/[\w./-]+)$/)?.[1];
      if (ref) {
        const sha = await this.readRef(ref);
        if (sha) return sha;
      }
    } catch {}
    return this.git(['rev-parse', 'HEAD']);
  }
  // Commit of a full ref name (e.g. refs/sitetiller/saved-drafts/<id>) from the loose or packed ref file, or null.
  private async readRef(ref: string) {
    const git = join(this.root, '.git');
    try {
      const sha = (await readFile(join(git, ref), 'utf8')).trim();
      if (/^[a-f0-9]{40}$/.test(sha)) return sha;
    } catch (e: any) {
      if (!['ENOENT', 'EISDIR'].includes(e.code)) throw e;
    }
    const line = (await readFile(join(git, 'packed-refs'), 'utf8').catch(() => ''))
      .split('\n')
      .find((l) => l.endsWith(' ' + ref));
    return line && /^[a-f0-9]{40} /.test(line) ? line.slice(0, 40) : null;
  }
  // Like `git rev-parse <ref>` for a full ref name, without starting a process when the ref files are readable.
  async resolveRef(ref: string) {
    if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) throw Error('Neplatný odkaz.');
    try {
      const sha = await this.readRef(ref);
      if (sha) return sha;
    } catch {}
    return this.git(['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
  }
  async history(limit: number | null = 20) {
    return (
      await this.git(['log', '--first-parent', ...(limit === null ? [] : ['-' + limit]), '--format=%H%x00%s%x00%cI'])
    )
      .split('\n')
      .map((s) => {
        const [commit, message, date] = s.split('\0');
        return { commit, message, date };
      });
  }
  async commit(message: string) {
    await this.git(['add', 'site']);
    if (await this.git(['diff', '--cached', '--name-only', '--', 'site']))
      await this.git(['commit', '-m', message.slice(0, 150)]);
    return this.head();
  }
  async test() {
    return staticChecks(await this.files());
  }
  async rewind(target: string, expectedHead: string, published: string | null) {
    if (!/^[a-f0-9]{40}$/.test(target) || !/^[a-f0-9]{40}$/.test(expectedHead)) throw Error('Neplatná verze.');
    if ((await this.head()) !== expectedHead) throw Error('Návrh se mezitím změnil. Obnov seznam úprav.');
    try {
      await this.git(['merge-base', '--is-ancestor', target, expectedHead]);
      if (published) await this.git(['merge-base', '--is-ancestor', published, target]);
    } catch {
      throw Error('Na tento krok se nelze vrátit bez změny historie publikování.');
    }
    if (
      (await this.git(['status', '--porcelain', '--untracked-files=no'])) ||
      (await this.git(['status', '--porcelain', '--', 'site']))
    )
      throw Error('Návrh obsahuje neuložené změny.');
    await this.git(['reset', '--hard', target]);
    return { commit: target };
  }
  async restore(target: string, expectedHead: string) {
    if (!/^[a-f0-9]{40}$/.test(target) || !/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Neplatná verze.');
    if ((await this.head()) !== expectedHead) throw new Error('Náhled se mezitím změnil. Obnov seznam verzí.');
    try {
      await this.git(['merge-base', '--is-ancestor', target, expectedHead]);
    } catch {
      throw new Error('Vybraná verze není v historii tohoto náhledu.');
    }
    if (target === expectedHead) throw new Error('Tato verze je již aktuální.');
    const temp = join(this.root, '..', 'restore-' + Date.now());
    await cp(this.root, temp, { recursive: true });
    try {
      const draft = new Project(temp);
      await draft.git(['restore', '--source=' + target, '--staged', '--worktree', '--', 'site']);
      const tests = await draft.test();
      if (!tests.passed) throw new Error('Vybraná verze neprošla kontrolou: ' + tests.errors.join('; '));
      // Commit even when content matches, keeping an explicit restoration record.
      await draft.git(['commit', '--allow-empty', '-m', 'Obnovení verze ' + target.slice(0, 8)]);
      const commit = await draft.head();
      if ((await this.head()) !== expectedHead) throw new Error('Náhled se mezitím změnil.');
      await this.git(['fetch', temp, 'HEAD']);
      await this.git(['merge', '--ff-only', 'FETCH_HEAD']);
      return { commit, restoredFrom: target, tests };
    } finally {
      await (await import('node:fs/promises')).rm(temp, { recursive: true, force: true });
    }
  }
  async committedFiles(commit: string) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Neplatný commit.');
    let pending = this.snapshotCache.get(commit);
    if (pending) {
      this.snapshotCache.delete(commit);
      this.snapshotCache.set(commit, pending);
      return { ...(await pending) };
    }
    pending = (async () => {
      const entries = (await this.git(['ls-tree', '-r', '-z', commit, 'site'])).split('\0').filter(Boolean),
        files: Record<string, string> = {};
      for (const entry of entries) {
        const tab = entry.indexOf('\t'),
          name = entry.slice(tab + 1),
          sha = entry.slice(0, tab).split(' ')[2];
        safeSitePath(this.root, name);
        if (binaryAsset(name)) {
          files[name] = '[Binary image asset]';
          continue;
        }
        const bytes = await this.readObject(sha);
        if (!bytes) throw Error('Soubor ' + name + ' ve verzi neexistuje.');
        files[name] = bytes.toString('utf8');
      }
      return files;
    })();
    if (this.snapshotCache.size >= SNAPSHOT_LIMIT) this.snapshotCache.delete(this.snapshotCache.keys().next().value!);
    this.snapshotCache.set(commit, pending);
    try {
      return { ...(await pending) };
    } catch (e) {
      this.snapshotCache.delete(commit);
      throw e;
    }
  }
}
