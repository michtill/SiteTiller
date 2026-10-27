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
