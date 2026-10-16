import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveForm, formDefinitions, recipientFromCms } from '../src/contact-forms.ts';
import { browserChecks, staticChecks } from '../src/checks.ts';
const definition = {
  version: 1,
  forms: {
    contact: {
      label: 'Contact',
      replyTo: 'email',
      recipientFromCms: { collection: 'content', record: 'email', field: 'content' },
      fields: [
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'message', label: 'Message', type: 'textarea', required: true, maxLength: 100 },
      ],
    },
  },
};
const files = {
  'site/forms.json': JSON.stringify(definition),
  'site/cms/structure.json': JSON.stringify({
    lists: { content: { key: 'code', columns: { code: { type: 'text' }, content: { type: 'text' } } } },
  }),
  'site/cms/data/content.json': '[{"code":"email","content":"owner@example.test"}]',
};
test('AI-28: form contract rejects mail configuration and recipient injection', () => {
  formDefinitions(files);
  for (const bad of [
    { ...definition.forms.contact, to: 'attacker@example.test' },
    { ...definition.forms.contact, replyTo: 'message' },
    { ...definition.forms.contact, recipientFromCms: { collection: '../config', record: 'email', field: 'content' } },
  ])
    assert.throws(() =>
      formDefinitions({ 'site/forms.json': JSON.stringify({ version: 1, forms: { contact: bad } }) }),
    );
});
test('AI-28: server validation, dry-run, SMTP delivery boundary and rate limit', async () => {
  const sent: any[] = [];
  let preview = true,
    fail = false;
  const server = http.createServer(async (req, res) => {
    if (
      !(await serveForm(req, res, (req.url || '').slice(1), files, {
        preview,
        origin: 'http://' + req.headers.host,
        deliver: async (mail) => {
          if (fail) throw Error('secret SMTP failure');
          sent.push(mail);
        },
      }))
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const post = (data: any, source = origin) =>
    fetch(origin + '/__sitetiller/forms/contact', {
      method: 'POST',
      headers: { Origin: source, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  try {
    let r = await post({ email: 'sender@example.test', message: 'hello' });
    assert.equal((await r.json()).preview, true);
    assert.equal(sent.length, 0);
    assert.equal((await post({ email: 'invalid', message: '' })).status, 422);
    assert.equal((await post({ email: 'sender@example.test', message: 'x', to: 'attacker@example.test' })).status, 422);
    assert.equal((await post({ _website: 'bot' })).status, 400);
    assert.equal((await post({}, 'https://foreign.example')).status, 403);
    preview = false;
    r = await post({ email: 'sender@example.test', message: 'hello' });
    assert.equal(r.status, 200);
    assert.equal(sent[0].to, 'owner@example.test');
    assert.equal(sent[0].replyTo, 'sender@example.test');
    assert.match(sent[0].text, /hello/);
    fail = true;
    r = await post({ email: 'sender@example.test', message: 'hello' });
    assert.equal(r.status, 503);
    assert.ok(!(await r.text()).includes('secret'));
    fail = false;
    assert.equal((await post({ email: 'sender@example.test', message: 'x'.repeat(33000) })).status, 413);
    for (let i = 0; i < 6; i++) r = await post({ email: 'sender@example.test', message: 'hello' });
    assert.equal(r.status, 429);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test('AI-28: recipient follows live CMS changes without website regeneration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'form-cms-')),
    previous = process.env.SITETILLER_CMS_ROOT;
  try {
    await mkdir(join(root, 'schema'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'schema/structure.json'), files['site/cms/structure.json']);
    const path = join(root, 'data/content.json');
    await writeFile(path, files['site/cms/data/content.json']);
    process.env.SITETILLER_CMS_ROOT = root;
    assert.equal(await recipientFromCms(definition.forms.contact as any, files), 'owner@example.test');
    await writeFile(path, '[{"code":"email","content":"new@example.test"}]');
    assert.equal(await recipientFromCms(definition.forms.contact as any, files), 'new@example.test');
    await writeFile(path, '[{"code":"email","content":"bad\\r\\nBcc: attacker@example.test"}]');
    await assert.rejects(recipientFromCms(definition.forms.contact as any, files));
  } finally {
    if (previous === undefined) delete process.env.SITETILLER_CMS_ROOT;
    else process.env.SITETILLER_CMS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test('AI-28: generated form submits in isolated browser with honest preview feedback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'form-browser-'));
  try {
    const page = `<!doctype html><html><head><title>Contact</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><form action="/__sitetiller/forms/contact" method="post"><label>Email<input name="email" type="email" required></label><label>Message<textarea name="message" required></textarea></label><input name="_website" hidden><button>Send</button></form><p role="status"></p><script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch(e.target.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const data=await r.json();document.querySelector('[role=status]').textContent=data.message;});</script></body></html>`;
    const candidate = { ...files, 'site/index.html': page };
    assert.equal(staticChecks(candidate).passed, true);
    const result = await browserChecks(root, candidate, [
      {
        name: 'Preview contact submission',
        path: 'site/index.html',
        steps: [
          { action: 'fill', selector: '[name=email]', value: 'sender@example.test' },
          { action: 'fill', selector: 'textarea', value: 'Browser message' },
          { action: 'click', selector: 'button' },
          { action: 'expectText', selector: '[role=status]', contains: 'E-mail se v náhledu neodesílá.' },
        ],
      },
    ]);
    assert.equal(result.passed, true, JSON.stringify(result.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AI-28: production runtime serves exported site and fails honestly when mail is unconfigured', async () => {
  const { websiteServer } = await import('../src/website-server.ts');
  const root = await mkdtemp(join(tmpdir(), 'form-production-')),
    oldHost = process.env.SITETILLER_SMTP_HOST;
  delete process.env.SITETILLER_SMTP_HOST;
  let server: any;
  try {
    await mkdir(join(root, 'cms/data'), { recursive: true });
    await writeFile(join(root, 'index.html'), 'Production website');
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name.slice(5)), text);
    server = websiteServer(root, 'http://127.0.0.1');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + (server.address() as any).port;
    assert.equal(await (await fetch(origin + '/')).text(), 'Production website');
    assert.equal((await fetch(origin + '/.env')).status, 404);
    const response = await fetch(origin + '/__sitetiller/forms/contact', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sender@example.test', message: 'Do not send mail' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (oldHost === undefined) delete process.env.SITETILLER_SMTP_HOST;
    else process.env.SITETILLER_SMTP_HOST = oldHost;
    await rm(root, { recursive: true, force: true });
  }
});
