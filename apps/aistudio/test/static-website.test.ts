import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { staticExport } from '../src/static-export.ts';
const exec = promisify(execFile);
// An invented website with a rendered page, a plain page, a file from the content and a contact form.
const release = () => ({
  'index.html': Buffer.from('<!doctype html><title>Fallback</title>'),
  'about.html': Buffer.from('<!doctype html><title>About</title><h1>About</h1>'),
  'style.css': Buffer.from('h1{color:#123456}'),
  'architecture.txt': Buffer.from('Architektura webu (nezveřejněný návrh)'),
  'rendering.json': Buffer.from(JSON.stringify({ version: 1, pages: { 'site/index.html': 'site/templates/index.txt' } })),
  'templates/index.txt': Buffer.from(
    '<!doctype html><html><head><title>{{value "content" "title" "content"}}</title></head><body><h1>{{value "content" "title" "content"}}</h1><img src="{{asset (value "content" "logo" "content")}}"></body></html>',
  ),
  'forms.json': Buffer.from(
    JSON.stringify({
      version: 1,
      forms: {
        contact: {
          label: 'Kontakt',
          replyTo: 'email',
          recipientFromCms: { collection: 'content', record: 'mail', field: 'content' },
          fields: [
            { name: 'email', label: 'E-mail', type: 'email', required: true },
            { name: 'message', label: 'Zpráva', type: 'textarea', required: true, maxLength: 100 },
          ],
        },
      },
    }),
  ),
  'cms/structure.json': Buffer.from(
    JSON.stringify({
      folders: { images: { label: 'Obrázky', type: 'img' } },
      lists: { content: { key: 'code', columns: { code: { type: 'text' }, content: { type: 'text' } } } },
    }),
  ),
  'cms/data/content.json': Buffer.from(
    JSON.stringify([
      { code: 'title', content: 'Ukázková kavárna' },
      { code: 'logo', content: 'images/logo.png' },
      { code: 'mail', content: 'owner@example.test' },
    ]),
  ),
  'cms/files/images/logo.png': Buffer.from([137, 80, 78, 71]),
});
const options = { siteUrl: 'https://example.test/' };
test('PU-12: the static export renders the pages, keeps the files and the content, and hides templates and form definitions', async () => {
  const out = await staticExport(release(), options);
  assert.match(out['index.html'].toString(), /<h1>Ukázková kavárna<\/h1>/);
  assert.match(out['index.html'].toString(), /cms\/files\/images\/logo\.png/);
  assert.equal(out['about.html'].toString(), '<!doctype html><title>About</title><h1>About</h1>');
  assert.deepEqual(out['cms/files/images/logo.png'], Buffer.from([137, 80, 78, 71]));
  assert.ok(out['cms/data/content.json']);
  for (const hidden of ['rendering.json', 'forms.json', 'architecture.txt', 'templates/index.txt']) assert.equal(out[hidden], undefined);
  // The form: a PHP script at the new and at the older address, with the recipient taken from the content.
  const script = out['__sitetiller/forms/contact.php'].toString();
  assert.deepEqual(out['__sitetiller/forms/contact/index.php'].toString(), script);
  const config = JSON.parse(Buffer.from(script.match(/base64_decode\('([^']+)'\)/)![1], 'base64').toString());
  assert.equal(config.to, 'owner@example.test');
  assert.equal(config.from, 'info@example.test');
  assert.equal(config.origin, 'https://example.test');
});
// External presentation: the website Git gets the export; the version history (here: none) stays in the instance.
async function externalWebsite(run: (ctx: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sitetiller-www-'));
  const env = { ...process.env };
  try {
    const production = join(root, 'production'),
      website = join(root, 'website.git'),
      first = join(production, 'releases', 'one');
    await mkdir(first, { recursive: true });
    for (const [name, bytes] of Object.entries(release())) {
      await mkdir(join(first, name, '..'), { recursive: true });
      await writeFile(join(first, name), bytes);
    }
    await writeFile(join(production, 'current.json'), JSON.stringify({ id: 'one', directory: first }));
    await exec('git', ['init', '--bare', '-b', 'main', website]);
    Object.assign(process.env, {
      SITETILLER_PRODUCTION_DIRECTORY: production,
      SITETILLER_SITE_URL: 'https://example.test/',
      SITETILLER_WEBSITE_GIT: website,
      SITETILLER_WEBSITE_BRANCH: 'main',
    });
    delete process.env.SITETILLER_WWW_URL;
    const { publishStaticWebsite, websiteState } = await import('../src/static-website.ts');
    const show = async (path: string) => (await exec('git', ['--git-dir=' + website, 'show', 'main:' + path])).stdout;
    const content = (title: string) =>
      writeFile(
        join(first, 'cms/data/content.json'),
        JSON.stringify([
          { code: 'title', content: title },
          { code: 'logo', content: 'images/logo.png' },
          { code: 'mail', content: 'owner@example.test' },
        ]),
      );
    const { websiteForeign } = await import('../src/static-website.ts');
    await run({ website, publishStaticWebsite, websiteState, websiteForeign, show, content });
  } finally {
    for (const key of [
      'SITETILLER_PRODUCTION_DIRECTORY',
      'SITETILLER_SITE_URL',
      'SITETILLER_WEBSITE_GIT',
      'SITETILLER_WEBSITE_BRANCH',
    ])
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    await rm(root, { recursive: true, force: true });
  }
}
test('PU-13: each publication adds the export to the website Git once; the same export adds nothing', () =>
  externalWebsite(async ({ website, publishStaticWebsite, show, content }) => {
    const one: any = await publishStaticWebsite();
    assert.equal(one.changed, true);
    assert.match(await show('index.html'), /Ukázková kavárna/);
    assert.equal(((await publishStaticWebsite()) as any).changed, false);
    // New content (a content publication): one more commit on top of the previous one.
    await content('Nová kavárna');
    const two: any = await publishStaticWebsite();
    assert.equal(two.changed, true);
    assert.match(await show('index.html'), /Nová kavárna/);
    assert.equal((await exec('git', ['--git-dir=' + website, 'rev-parse', 'main^'])).stdout.trim(), one.commit);
  }));
test('PU-15: someone else\'s change in the website Git stops the write until "Publish anyway"; nothing is deleted', () =>
  externalWebsite(async ({ website, publishStaticWebsite, websiteState, websiteForeign, show, content }) => {
    const one: any = await publishStaticWebsite();
    assert.equal(await websiteForeign(), null);
    // Someone else adds a file to the website Git.
    const other = join(website, '..', 'other');
    await exec('git', ['clone', website, other]);
    await writeFile(join(other, 'robots.txt'), 'User-agent: *\n');
    const inOther = (args: string[]) =>
      exec('git', ['-c', 'user.name=Other', '-c', 'user.email=other@example.test', '-C', other, ...args]);
    await inOther(['add', 'robots.txt']);
    await inOther(['commit', '-m', 'Someone else']);
    await inOther(['push', 'origin', 'main']);
    const foreign = (await exec('git', ['--git-dir=' + website, 'rev-parse', 'main'])).stdout.trim();
    // The check before a publication sees it (the studios then offer Publish anyway / Cancel).
    assert.deepEqual(await websiteForeign(), { head: foreign });
    await content('Nová kavárna');
    const stopped: any = await publishStaticWebsite();
    assert.deepEqual(stopped.foreign, { head: foreign });
    assert.equal((await exec('git', ['--git-dir=' + website, 'rev-parse', 'main'])).stdout.trim(), foreign);
    assert.ok((await websiteState()).foreign);
    // A content publication without confirmation does not override it either.
    assert.ok(((await publishStaticWebsite()) as any).foreign);
    // Publish anyway: a new commit on top of the foreign one; its change stays in the history.
    const forced: any = await publishStaticWebsite({ force: true });
    assert.equal(forced.changed, true);
    assert.equal((await exec('git', ['--git-dir=' + website, 'rev-parse', 'main^'])).stdout.trim(), foreign);
    assert.match(await show('index.html'), /Nová kavárna/);
    assert.equal((await exec('git', ['--git-dir=' + website, 'show', foreign + ':robots.txt'])).stdout, 'User-agent: *\n');
    assert.equal((await websiteState()).foreign, undefined);
    assert.equal(await websiteForeign(), null);
    assert.notEqual(forced.commit, one.commit);
  }));
// PHP from SITETILLER_PHP (e.g. a WAMP php.exe on Windows) or from PATH.
const phpBinary = process.env.SITETILLER_PHP || 'php',
  php = spawnSync(phpBinary, ['-v']).status === 0;
// Collects the messages PHP's mail() hands over: through sendmail on Linux, through SMTP on Windows.
async function mailCapture(root: string) {
  const file = join(root, 'mails.txt');
  await writeFile(file, '');
  if (process.platform !== 'win32') {
    await writeFile(join(root, 'sendmail.sh'), '#!/bin/sh\ncat >> "' + file + '"\n', { mode: 0o755 });
    return { file, args: ['-d', 'sendmail_path=' + join(root, 'sendmail.sh')], close() {} };
  }
  const smtp = net.createServer((socket) => {
    let data = false,
      buffer = '';
    socket.write('220 test\r\n');
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 queued\r\n');
          } else await writeFile(file, line + '\n', { flag: 'a' });
        } else if (/^DATA/i.test(line)) {
          data = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else {
          if (/^RCPT TO/i.test(line)) await writeFile(file, line + '\n', { flag: 'a' });
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  const port = await new Promise<number>((resolve) => smtp.listen(0, '127.0.0.1', () => resolve((smtp.address() as any).port)));
  return { file, args: ['-d', 'SMTP=127.0.0.1', '-d', 'smtp_port=' + port], close: () => smtp.close() };
}
test(
  'PU-14: the PHP form validates like the website runtime, limits submissions and sends the mail to the content recipient',
  { skip: !php && 'needs PHP (SITETILLER_PHP or php on PATH; runs in CI)' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sitetiller-php-form-'));
    let server: any, capture: any;
    try {
      const out = await staticExport(release(), { siteUrl: 'http://127.0.0.1/' });
      const web = join(root, 'www');
      for (const [name, bytes] of Object.entries(out)) {
        await mkdir(join(web, name, '..'), { recursive: true });
        await writeFile(join(web, name), bytes);
      }
      capture = await mailCapture(root);
      const port = await new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
          const p = (s.address() as any).port;
          s.close(() => resolve(p));
        });
      });
      server = spawn(phpBinary, [...capture.args, '-d', 'sys_temp_dir=' + root, '-S', '127.0.0.1:' + port, '-t', web], {
        stdio: 'ignore',
      });
      const url = 'http://127.0.0.1:' + port + '/__sitetiller/forms/contact.php';
      for (let i = 0; i < 50; i++) {
        try {
          await fetch(url);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const post = (body: any, headers: Record<string, string> = {}) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', ...headers },
          body: JSON.stringify(body),
        });
      assert.equal((await fetch(url)).status, 405);
      assert.equal((await post({ email: 'a@b.cz', message: 'Ahoj' }, { Origin: 'https://evil.test' })).status, 403);
      const invalid = await post({ email: 'nope', message: '' });
      assert.equal(invalid.status, 422);
      assert.deepEqual(Object.keys((await invalid.json()).errors).sort(), ['email', 'message']);
      assert.equal((await post({ email: 'a@b.cz', message: 'x', extra: '1' })).status, 422);
      assert.equal((await post({ email: 'a@b.cz', message: 'x', _website: 'bot' })).status, 400);
      const sent = await post({ email: 'visitor@example.test', message: 'Dobrý den' });
      assert.equal(sent.status, 200, await sent.clone().text());
      assert.deepEqual(await sent.json(), { ok: true, preview: false, message: 'Zpráva byla odeslána.' });
      const mail = await readFile(capture.file, 'utf8');
      assert.match(mail, /owner@example\.test/);
      assert.match(mail, /Reply-To: visitor@example\.test/);
      assert.match(mail, /Dobrý den/);
      // Four requests so far count (a wrong origin is refused before counting); the 11th in ten minutes is refused.
      for (let i = 0; i < 6; i++) await post({ email: 'a@b.cz', message: 'x' });
      assert.equal((await post({ email: 'a@b.cz', message: 'x' })).status, 429);
    } finally {
      server?.kill();
      capture?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  },
);
