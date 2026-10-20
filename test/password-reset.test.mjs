import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { saveMailSettings } from '../packages/settings/mail.mjs';
import { smtpCapture } from './support/smtp-capture.mjs';
import { isolatedStack } from './support/stack.mjs';
test('SH-13: forgot password sends a one-time 30-minute link to the administrator; the new password signs out everywhere', async () => {
  const stack = await isolatedStack(),
    smtp = await smtpCapture();
  try {
    const signIn = (password) =>
      fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password }),
        redirect: 'manual',
      });
    // Without sending e-mail the link is not offered.
    assert.doesNotMatch(await (await fetch(stack.origin + '/login')).text(), /href="\/forgot"/);
    const old = await signIn(stack.password),
      oldCookie = old.headers.get('set-cookie').split(';')[0];
    await saveMailSettings(join(stack.root, 'settings'), {
      host: '127.0.0.1',
      port: String(smtp.port),
      from: 'info@example.test',
    });
    assert.match(await (await fetch(stack.origin + '/login')).text(), /href="\/forgot"/);
    const send = () => fetch(stack.origin + '/forgot', { method: 'POST', headers: { Origin: stack.origin } });
    let r = await send();
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Odkaz byl odeslán na e-mail správce/);
    assert.deepEqual(smtp.messages[0].to, ['admin@example.test']);
    // Quoted-printable may wrap the link; join soft line breaks before reading it.
    const body = smtp.messages[0].text.replace(/=\n/g, ''),
      link = body.match(/\/reset\/([a-f0-9]{64})/)[0];
    assert.doesNotMatch(body, new RegExp(stack.password));
    assert.equal((await fetch(stack.origin + link)).status, 200);
    // Mismatched passwords are refused and the link still works.
    r = await fetch(stack.origin + link, {
      method: 'POST',
      headers: { Origin: stack.origin },
      body: new URLSearchParams({ newPassword: 'example-new-1', confirmPassword: 'example-new-2' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 422);
    r = await fetch(stack.origin + link, {
      method: 'POST',
      headers: { Origin: stack.origin },
      body: new URLSearchParams({ newPassword: 'example-new-1', confirmPassword: 'example-new-1' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/content/');
    const fresh = r.headers.get('set-cookie').split(';')[0];
    // The user is signed in, every earlier session is signed out and the link is used up.
    assert.equal((await fetch(stack.origin + '/', { headers: { Cookie: fresh }, redirect: 'manual' })).status, 200);
    assert.equal((await fetch(stack.origin + '/', { headers: { Cookie: oldCookie }, redirect: 'manual' })).status, 303);
    assert.equal((await fetch(stack.origin + link)).status, 410);
    assert.equal((await signIn(stack.password)).status, 401);
    assert.equal((await signIn('example-new-1')).status, 303);
    // At most 3 e-mails an hour.
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    r = await send();
    assert.equal(r.status, 429);
    assert.match(await r.text(), /Za poslední hodinu už odešly 3 odkazy/);
    assert.equal(smtp.messages.length, 3);
  } finally {
    await smtp.close();
    await stack.close();
  }
});
