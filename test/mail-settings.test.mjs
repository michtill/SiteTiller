import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson, validateShared } from '../packages/settings/index.mjs';
import { mailSettings, saveMailSettings, sendMail } from '../packages/settings/mail.mjs';
import { smtpDelivery } from '../apps/aistudio/src/contact-forms.ts';
import { smtpCapture } from './support/smtp-capture.mjs';
import { isolatedStack } from './support/stack.mjs';
import http from 'node:http';
import { mailApiUrls } from '../packages/settings/mail-apis.mjs';
import { allowedNetworkURL } from '../scripts/network-policy.mjs';
test('SH-12: the administrator e-mail must be a valid address and sending e-mail keeps its password encrypted', async () => {
  const settings = await mkdtemp(join(tmpdir(), 'example-mail-settings-')),
    smtp = await smtpCapture();
  const old = process.env.SITETILLER_SHARED_SETTINGS_FILE;
  try {
    // The administrator e-mail is saved only as a valid address.
    const base = { name: 'Example', theme: 'light' };
    assert.throws(() => validateShared({ ...base, adminEmail: '' }, { current: {} }), { status: 422 });
    assert.throws(() => validateShared({ ...base, adminEmail: 'not an address' }, { current: {} }), { status: 422 });
    assert.equal(validateShared({ ...base, adminEmail: ' admin@example.test ' }, { current: {} }).adminEmail, 'admin@example.test');
    await atomicJson(join(settings, 'shared.json'), { ...base, adminEmail: 'admin@example.test' });
    // Not set up yet.
    assert.equal((await mailSettings(settings)).configured, false);
    await assert.rejects(sendMail(settings, { to: 'admin@example.test', subject: 'x', text: 'x' }), { status: 503 });
    // A real server needs port 465 or 587; a relay on this computer may use any port.
    await assert.rejects(saveMailSettings(settings, { host: 'smtp.example.test', port: '25', from: 'info@example.test' }), {
      status: 422,
    });
    const saved = await saveMailSettings(settings, {
      host: '127.0.0.1',
      port: String(smtp.port),
      user: 'mailer',
      password: 'example-mail-secret',
      from: 'info@example.test',
    });
    assert.deepEqual([saved.configured, saved.passwordSet], [true, true]);
    // The password is stored encrypted and never returned; an empty field keeps it.
    const file = await readFile(join(settings, 'mail.json'), 'utf8');
    assert.ok(!file.includes('example-mail-secret'));
    assert.equal(JSON.stringify(await mailSettings(settings)).includes('example-mail-secret'), false);
    await saveMailSettings(settings, { host: '127.0.0.1', port: String(smtp.port), user: 'mailer', password: '', from: 'info@example.test' });
    assert.equal((await mailSettings(settings)).passwordSet, true);
    // A form without a recipient in the content sends to the administrator e-mail, from the configured sender.
    process.env.SITETILLER_SHARED_SETTINGS_FILE = join(settings, 'shared.json');
    await smtpDelivery({ to: '', subject: 'Contact', text: 'Hello from the form' });
    assert.deepEqual([smtp.messages[0].from, smtp.messages[0].to], ['info@example.test', ['admin@example.test']]);
    assert.match(smtp.messages[0].text, /Hello from the form/);
  } finally {
    if (old === undefined) delete process.env.SITETILLER_SHARED_SETTINGS_FILE;
    else process.env.SITETILLER_SHARED_SETTINGS_FILE = old;
    await smtp.close();
    await rm(settings, { recursive: true, force: true });
  }
});
test('SH-12: everything about mail is set on one screen; the test e-mail goes to the administrator without a separate save', async () => {
  const stack = await isolatedStack(),
    smtp = await smtpCapture();
  try {
    const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: stack.origin };
    let html = await (await fetch(stack.origin + '/settings', { headers })).text();
    // Interface settings: no mail fields; the settings band marks E-mails until sending is set up.
    assert.doesNotMatch(html, /name="adminEmail"/);
    assert.match(html, /href="\/settings\/mail\?returnTo=[^"]*">E-maily<span class="nav-warning"/);
    assert.match(html, /Odesílání e-mailů není nastavené/);
    // Sending e-mail: the administrator e-mail is the first, required field.
    assert.match(await (await fetch(stack.origin + '/settings/mail', { headers })).text(), /name="adminEmail"[^>]*required/);
    const r = await fetch(stack.origin + '/settings/mail', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        adminEmail: 'owner@example.test',
        host: '127.0.0.1',
        port: String(smtp.port),
        user: '',
        password: '',
        from: 'info@example.test',
        action: 'test',
      }),
    });
    html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /Zkušební e-mail byl odeslán na owner@example\.test/);
    assert.deepEqual(smtp.messages[0].to, ['owner@example.test']);
    assert.equal((await readJson(join(stack.root, 'settings/shared.json'))).adminEmail, 'owner@example.test');
    html = await (await fetch(stack.origin + '/settings', { headers })).text();
    assert.doesNotMatch(html, /Odesílání e-mailů není nastavené/);
  } finally {
    await smtp.close();
    await stack.close();
  }
});
test('SH-12: Brevo and Resend send only to their fixed API address with the key in a header, keep the key encrypted and report a refusal by its code without the reply body', async () => {
  const settings = await mkdtemp(join(tmpdir(), 'example-mail-api-')),
    received = [];
  let status = 201;
  // The local replacement of both APIs: it keeps every request and answers with the status set by the test.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'example-reply-body-detail' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port,
    addresses = [],
    request = (url, options) => {
      addresses.push(url);
      return fetch(local + new URL(url).pathname, options);
    };
  try {
    // Every network mode lets through only POST to the two fixed addresses, nothing else of those hosts.
    for (const mode of ['offline', 'providers']) {
      for (const url of mailApiUrls) {
        assert.equal(allowedNetworkURL(mode, url, 'POST'), true, url);
        assert.equal(allowedNetworkURL(mode, url), false, url);
      }
      for (const url of [
        'https://api.brevo.com/v3/account',
        'https://api.brevo.com/v3/smtp/email?api-key=x',
        'http://api.resend.com/emails',
        'https://user:x@api.resend.com/emails',
        'https://api.resend.com/emails/batch',
      ])
        assert.equal(allowedNetworkURL(mode, url, 'POST'), false, url);
    }
    // An unknown service is refused; the SMTP settings without a service stay the SMTP server.
    await assert.rejects(saveMailSettings(settings, { service: 'other', from: 'info@example.test' }), { status: 422 });
    await saveMailSettings(settings, { host: 'smtp.example.test', port: '587', from: 'info@example.test' });
    assert.equal((await mailSettings(settings)).service, 'smtp');
    // Brevo without its key is not set up; with it, the key is stored encrypted and never returned.
    let saved = await saveMailSettings(settings, {
      service: 'brevo',
      host: 'smtp.example.test',
      port: '587',
      from: 'info@example.test',
    });
    assert.deepEqual([saved.service, saved.configured, saved.keySet.brevo], ['brevo', false, false]);
    saved = await saveMailSettings(settings, {
      service: 'brevo',
      host: 'smtp.example.test',
      port: '587',
      from: 'info@example.test',
      brevoKey: 'example-brevo-key',
    });
    assert.deepEqual([saved.configured, saved.keySet.brevo, saved.keySet.resend], [true, true, false]);
    assert.ok(!(await readFile(join(settings, 'mail.json'), 'utf8')).includes('example-brevo-key'));
    assert.ok(!JSON.stringify(saved).includes('example-brevo-key'));
    await sendMail(
      settings,
      { to: 'admin@example.test', subject: 'Contact', text: 'Hello', replyTo: 'visitor@example.test' },
      { fetch: request },
    );
    assert.deepEqual(addresses, ['https://api.brevo.com/v3/smtp/email']);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].headers['api-key'], 'example-brevo-key');
    assert.deepEqual(received[0].body, {
      sender: { email: 'info@example.test' },
      to: [{ email: 'admin@example.test' }],
      subject: 'Contact',
      textContent: 'Hello',
      replyTo: { email: 'visitor@example.test' },
    });
    // Resend: its own key; switching keeps the Brevo key and the SMTP server.
    status = 200;
    saved = await saveMailSettings(settings, {
      service: 'resend',
      host: 'smtp.example.test',
      port: '587',
      from: 'onboarding@resend.dev',
      resendKey: 'example-resend-key',
    });
    assert.deepEqual([saved.keySet.brevo, saved.keySet.resend, saved.host], [true, true, 'smtp.example.test']);
    await sendMail(settings, { to: 'admin@example.test', subject: 'Test', text: 'Hello' }, { fetch: request });
    assert.equal(addresses[1], 'https://api.resend.com/emails');
    assert.equal(received[1].headers.authorization, 'Bearer example-resend-key');
    assert.deepEqual(received[1].body, {
      from: 'onboarding@resend.dev',
      to: ['admin@example.test'],
      subject: 'Test',
      text: 'Hello',
    });
    // A refusal says the service and the meaning of the code, never the reply body.
    for (const [code, meaning] of [
      [401, /Resend odmítla API klíč \(HTTP 401\)/],
      [422, /odesílatel musí být u služby ověřený \(HTTP 422\)/],
      [429, /limit odesílání/],
      [503, /má potíže/],
    ]) {
      status = code;
      const error = await sendMail(settings, { to: 'admin@example.test', subject: 'x', text: 'x' }, { fetch: request }).catch(
        (e) => e,
      );
      assert.match(error.message, meaning);
      assert.ok(!error.message.includes('example-reply-body-detail'));
    }
    const unreachable = await sendMail(
      settings,
      { to: 'admin@example.test', subject: 'x', text: 'x' },
      { fetch: () => Promise.reject(Error('example network detail')) },
    ).catch((e) => e);
    assert.equal(unreachable.message, 'Služba Resend není dostupná.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(settings, { recursive: true, force: true });
  }
});
test('SH-12: the E-mails screen chooses the service and keeps its API key hidden', async () => {
  const stack = await isolatedStack();
  try {
    const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: stack.origin };
    let html = await (await fetch(stack.origin + '/settings/mail', { headers })).text();
    // The SMTP server is the default; the API fields are there but hidden.
    assert.match(html, /<option value="smtp" selected/);
    assert.match(html, /data-service="brevo" hidden/);
    const r = await fetch(stack.origin + '/settings/mail', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        adminEmail: 'owner@example.test',
        service: 'brevo',
        host: '',
        port: '587',
        user: '',
        password: '',
        brevoKey: 'example-screen-key',
        resendKey: '',
        from: 'info@example.test',
        action: 'save',
      }),
    });
    html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /<option value="brevo" selected/);
    assert.match(html, /data-service="smtp" hidden/);
    assert.match(html, /placeholder="Klíč je uložený\. Prázdné pole ho nezmění\."/);
    assert.ok(!html.includes('example-screen-key'));
    assert.ok(!(await readFile(join(stack.root, 'settings/mail.json'), 'utf8')).includes('example-screen-key'));
    // Set up with Brevo: the settings band no longer warns.
    assert.doesNotMatch(
      await (await fetch(stack.origin + '/settings', { headers })).text(),
      /Odesílání e-mailů není nastavené/,
    );
  } finally {
    await stack.close();
  }
});
