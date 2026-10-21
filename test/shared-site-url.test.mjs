import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
// The live website to load is the published website from the installation; the Settings have no address field and
// another address applies to one comparison only (documentation 2.4, 4.5).
test(
  'SH-09: the Settings show the instance addresses read only; the live website is the published website and another address applies to one load only',
  { timeout: 240000 },
  async () => {
    const stack = await isolatedStack({ controllerImports: ['test/fixtures/live-website-snapshot.mjs'] });
    try {
      const response = await fetch(stack.origin + '/login', {
          method: 'POST',
          headers: { Origin: stack.origin },
          body: new URLSearchParams({ password: stack.password }),
          redirect: 'manual',
        }),
        cookie = response.headers.get('set-cookie').split(';')[0],
        headers = { Cookie: cookie, Origin: stack.origin, 'Content-Type': 'application/json' };
      // An address left in the common settings by an older version is not used.
      const sharedPath = join(stack.root, 'settings/shared.json'),
        shared = JSON.parse(await readFile(sharedPath, 'utf8'));
      await writeFile(sharedPath, JSON.stringify({ ...shared, siteUrl: 'https://old-setting.example/' }));
      const state = await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      assert.equal(state.siteUrl, stack.website + '/');
      // The Settings have no address field.
      const settings = await (await fetch(stack.origin + '/settings', { headers })).text();
      assert.doesNotMatch(settings, /name="siteUrl"/);
      // Settings → Addresses and sharing: the instance addresses read only, editor, public preview and published
      // website (internal mode: no Git).
      const addresses = await (await fetch(stack.origin + '/settings/addresses', { headers })).text();
      assert.match(addresses, /Adresy aplikace/);
      for (const address of [stack.origin, stack.website + '/'])
        assert.ok(addresses.includes('value="' + address + '"'), address);
      assert.doesNotMatch(addresses, /Git webu/);
      assert.doesNotMatch(settings, /Adresy aplikace/);
      const compare = (body) =>
        fetch(stack.origin + '/site/api/reality/compare', {
          method: 'POST',
          headers,
          body: JSON.stringify({ commit: state.head, expectedHead: state.head, ...body }),
        });
      for (const url of ['javascript:alert(1)', 'https://user:pass@example.com/', 42])
        assert.equal((await compare({ url })).status, 422, String(url));
      // Another public address for this one comparison (the hosting stand-in serves it).
      const other = await compare({ url: 'https://web.example.test/' });
      assert.equal(other.status, 200, await other.clone().text());
      assert.equal((await other.json()).url, 'https://web.example.test/');
      assert.equal(
        (await (await fetch(stack.origin + '/site/api/state', { headers })).json()).siteUrl,
        stack.website + '/',
      );
      // The AI settings do not take an address.
      const write = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          siteUrl: 'https://x.example/',
          roles: state.roles,
          imageModels: state.imageModels,
          keys: {},
        }),
      });
      assert.equal(write.status, 400);
    } finally {
      await stack.close();
    }
  },
);
