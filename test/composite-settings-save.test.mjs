import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
import { renderPage, settingsError } from '../apps/shell/pages.ts';
import { revision } from '../packages/settings/index.mjs';
test('I18-01: EN common error envelopes translate ordinary validation/conflicts/default mode without touching authored values', async () => {
  for (const [source, english] of [
    ['Neplatné společné nastavení.', 'Invalid common settings.'],
    ['Neplatný jazyk rozhraní.', 'Invalid interface language.'],
    ['Nastavení se mezitím změnilo.', 'Settings changed while you were editing.'],
    [
      'Živou editaci lze zapnout až po publikování všech úprav.',
      'Live editing can only be enabled after all changes are published.',
    ],
  ]) {
    const html = await renderPage(
      'settings',
      {
        fields: { name: 'Přihlásit se', theme: 'blue', language: 'en' },
        error: settingsError(source, 'en'),
        returnTo: '/site/',
        revision: revision({}),
      },
      { language: 'en', theme: 'blue', site: 'Přihlásit se' },
    );
    assert.ok(html.includes(english));
    assert.ok(!html.includes(source));
    assert.ok(html.includes('name="name" value="Přihlásit se"'));
  }
  assert.equal(
    settingsError('Unknown field for owner Alice', 'en'),
    'Settings could not be saved. Unknown field for owner Alice',
  );
});
test('SH-04: concurrent settings saves wait in one queue; a failed save changes nothing; the default edit mode is saved in the Shared settings', async () => {
  const stack = await isolatedStack({ shellImports: ['test/support/composite-settings-fault.mjs'] });
  let first, second;
  try {
    const login = await fetch(stack.origin + '/login', {
        method: 'POST',
        headers: { Origin: stack.origin },
        body: new URLSearchParams({ password: stack.password }),
        redirect: 'manual',
      }),
      cookie = login.headers.get('set-cookie').split(';')[0],
      headers = { Cookie: cookie, Origin: stack.origin },
      load = async () => await (await fetch(stack.origin + '/settings?returnTo=%2Fsite%2F', { headers })).text(),
      fields = (html) => ({
        revision: html.match(/name="revision" value="([^"]+)"/)[1],
      }),
      post = (body) =>
        fetch(stack.origin + '/settings', {
          method: 'POST',
          headers,
          body: new URLSearchParams(body),
          redirect: 'manual',
        }),
      sharedPath = join(stack.root, 'settings/shared.json'),
      hold = join(stack.root, 'hold-composite-save'),
      sharedBefore = await readFile(sharedPath, 'utf8'),
      pointer = await readFile(join(stack.root, '.production/current.json'), 'utf8');
    // The Content Editor is already open: its mode is settled (draft, the default) before the default changes.
    const cm = 'http://127.0.0.1:' + stack.ports.cmstudio;
    assert.equal((await (await fetch(cm + '/api/edit-mode')).json()).autoPublish, false);
    const initial = fields(await load());
    await writeFile(hold, 'fixture');
    first = post({
      ...initial,
      returnTo: '/site/',
      name: 'First',
      theme: 'green',
      language: 'cs',
      contentDefault: 'live',
    });
    let entered = false;
    for (let i = 0; i < 300; i++) {
      try {
        await readFile(join(stack.root, 'composite-entered'));
        entered = true;
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(entered, true);
    const intermediate = fields(await load());
    let secondSettled = false;
    second = post({
      ...intermediate,
      returnTo: '/site/',
      name: 'Přihlásit se',
      theme: 'blue',
      language: 'en',
      contentDefault: 'live',
    }).then((r) => {
      secondSettled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      secondSettled,
      false,
      'The whole second composite save must wait, not commit while first rollback is pending',
    );
    assert.equal(await readFile(sharedPath, 'utf8'), sharedBefore);
    await rm(hold);
    const failedFirst = await first;
    assert.equal(failedFirst.status, 503);
    const firstHtml = await failedFirst.text();
    assert.ok(firstHtml.includes('name="name" value="First"'));
    assert.ok(firstHtml.includes('value="live" selected'));
    // The first save failed without changing the file, so the waiting save still matches and goes through.
    assert.equal((await second).status, 303);
    const saved = JSON.parse(await readFile(sharedPath, 'utf8'));
    assert.equal(saved.name, 'Přihlásit se');
    assert.equal(saved.language, 'en');
    assert.equal(saved.contentDefault, 'live');
    // Saving the default never switches the running Content Editor.
    assert.equal((await (await fetch(cm + '/api/edit-mode')).json()).autoPublish, false);
    let html = await load();
    assert.ok(html.includes('value="live" selected'));
    const invalid = await post({
      ...fields(html),
      returnTo: '/site/',
      name: '',
      theme: 'blue',
      language: 'en',
      contentDefault: 'live',
    });
    assert.equal(invalid.status, 422);
    html = await invalid.text();
    assert.ok(html.includes('Invalid common settings.'));
    assert.ok(html.includes('name="name" value=""'));
    assert.equal(JSON.parse(await readFile(sharedPath, 'utf8')).name, 'Přihlásit se');
    assert.equal(JSON.parse(await readFile(sharedPath, 'utf8')).contentDefault, 'live');
    assert.equal(await readFile(join(stack.root, '.production/current.json'), 'utf8'), pointer);
  } finally {
    await rm(join(stack.root, 'hold-composite-save'), { force: true });
    await Promise.allSettled([first, second].filter(Boolean));
    await stack.close();
  }
});
