// Settings → Instance data (documentation 2.4): the whole instance folder as one ZIP, written while it is sent. Left out
// are only temporary and run-time files (logs, process records, locks), which a restored instance makes anew.
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createDeflateRaw, crc32 } from 'node:zlib';
import type { Writable } from 'node:stream';
const skippedTop = new Set(['logs', 'processes.json', 'supervised.json', 'lost+found']);
// A path relative to the instance (with /) that the export leaves out.
export function exportSkips(path: string) {
  const top = path.split('/')[0];
  return skippedTop.has(top) || /\.(lock|tmp)$/.test(path) || path.split('/').includes('node_modules');
}
// Every file of the instance to export, sorted, relative with /.
export async function exportFiles(root: string) {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name),
        name = relative(root, path).split(sep).join('/');
      if (exportSkips(name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(name);
    }
  };
  await walk(root);
  return files;
}
const dosTime = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};
const write = (out: Writable, chunk: Buffer) =>
  new Promise<void>((ok, fail) => out.write(chunk, (e) => (e ? fail(e) : ok())));
// Writes the ZIP (deflate, data descriptors) of `root` to `out`. Up to 4 GB in total: larger needs ZIP64, refused.
export async function writeInstanceZip(root: string, out: Writable) {
  const central: Buffer[] = [];
  let offset = 0,
    count = 0;
  for (const name of await exportFiles(root)) {
    const path = join(root, name),
      info = await lstat(path),
      { time, date } = dosTime(info.mtime),
      fileName = Buffer.from(name, 'utf8'),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor follows, UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(fileName.length, 26);
    await write(out, Buffer.concat([header, fileName]));
    const start = offset;
    offset += header.length + fileName.length;
    let crc = 0,
      size = 0,
      compressed = 0;
    await new Promise<void>((ok, fail) => {
      const deflate = createDeflateRaw();
      deflate.on('data', (chunk: Buffer) => {
        compressed += chunk.length;
        if (!out.write(chunk)) {
          deflate.pause();
          out.once('drain', () => deflate.resume());
        }
      });
      deflate.on('end', ok);
      deflate.on('error', fail);
      const input = createReadStream(path);
      input.on('data', (chunk) => {
        const data = chunk as Buffer;
        crc = crc32(data, crc);
        size += data.length;
      });
      input.on('error', fail);
      input.pipe(deflate);
    });
    offset += compressed;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(out, descriptor);
    offset += 16;
    if (offset > 0xffffffff || size > 0xffffffff) throw Error('The instance is larger than 4 GB; the ZIP export needs ZIP64');
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by Unix, version 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(compressed, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE((((info.mode & 0o777) | 0o100000) << 16) >>> 0, 38);
    entry.writeUInt32LE(start, 42);
    central.push(entry, fileName);
    count++;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  if (count > 0xffff) throw Error('The instance has more than 65535 files; the ZIP export needs ZIP64');
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, Buffer.concat([directory, end]));
}
// The file name: <instance name>-<date>.zip, only safe characters.
export function exportName(site: string, now = new Date()) {
  const base =
    site
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'sitetiller';
  return base + '-' + now.toISOString().slice(0, 10) + '.zip';
}
