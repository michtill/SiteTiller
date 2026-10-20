import { test } from 'node:test';
import { sessionCookie } from '../apps/shell/session-cookie.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  atomicJson,
  readJson,
  revision,
  validateShared,
  migrateSharedSiteUrl,
  readSharedSiteUrl,
  updateSettings,
} from '../packages/settings/index.mjs';
import { settingsSiteUrl } from '../apps/aistudio/src/settings-site-url.ts';
import { isolatedStack } from './support/stack.mjs';
import { launchBrowser, studioFrame, openAiSettings } from './support/browser.mjs';
let studio;
test(
  'SH-09: shared address migration preserves legacy file, existing/empty authority, CAS and omitted address',
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shared-address-'));
    try {
      const path = join(dir, 'shared.json'),
        legacy = join(dir, 'legacy.json'),
        initial = { name: 'Fixture', theme: 'green' };
      await atomicJson(path, initial);
      await atomicJson(legacy, { siteUrl: 'https://legacy.example/a', providers: { fixture: 'unchanged' } });
      const legacyBytes = await readFile(legacy, 'utf8');
      const migrated = await migrateSharedSiteUrl(path, legacy, settingsSiteUrl);
      assert.equal(migrated.siteUrl, 'https://legacy.example/a');
      assert.equal(await readFile(legacy, 'utf8'), legacyBytes);
      const kept = validateShared(
        { name: 'New', theme: 'blue' },
        { current: migrated, validateSiteUrl: settingsSiteUrl },
      );
      assert.equal(kept.siteUrl, migrated.siteUrl);
      await updateSettings(path, { ...kept, siteUrl: '' }, revision(migrated));
      assert.equal(
        (
          await migrateSharedSiteUrl(path, 'missing', () => {
            throw Error('must not migrate empty');
          })
        ).siteUrl,
        '',
      );
      assert.equal(await readSharedSiteUrl(path, 'https://legacy.example/', 'https://fallback.example/'), '');
      await assert.rejects(updateSettings(path, migrated, revision(migrated)), { status: 409 });
      await atomicJson(path, { ...initial, siteUrl: 'https://shared.example/' });
      assert.equal((await migrateSharedSiteUrl(path, legacy, settingsSiteUrl)).siteUrl, 'https://shared.example/');
      for (const siteUrl of ['javascript:alert(1)', 'https://user:pass@example.com/', 42, 'x'.repeat(2001)])
        assert.throws(
          () => validateShared({ ...initial, siteUrl }, { current: migrated, validateSiteUrl: settingsSiteUrl }),
          { status: 422 },
        );
      assert.equal(
        validateShared({ ...initial, siteUrl: '' }, { current: migrated, validateSiteUrl: settingsSiteUrl }).siteUrl,
        '',
      );
      assert.equal(await readSharedSiteUrl(undefined, '', 'https://fallback.example/'), '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  'SH-09: common address form round trips, AI reads shared live, legacy AI address writes rejected and return preserved',
  { timeout: 240000 },
  async () => {
    const stack = await isolatedStack();
    let browser;
    try {
      const response = await fetch(stack.origin + '/login', {
          method: 'POST',
          headers: { Origin: stack.origin },
          body: new URLSearchParams({ password: stack.password }),
          redirect: 'manual',
        }),
        cookie = response.headers.get('set-cookie').split(';')[0],
        headers = { Cookie: cookie, Origin: stack.origin },
        path = join(stack.root, 'settings/shared.json'),
        legacyPath = join(stack.root, '.sitetiller/config.json'),
        legacyBefore = await readFile(legacyPath, 'utf8');
      let shared = await readJson(path);
      assert.equal(shared.siteUrl, stack.website + '/');
      const save = async (values, rev = revision(shared)) =>
        fetch(stack.origin + '/settings', {
          method: 'POST',
          headers,
          body: new URLSearchParams({
            name: shared.name,
            theme: shared.theme,
            returnTo: '/site/?from=settings',
            revision: rev,
            ...values,
          }),
          redirect: 'manual',
        });
      let saved = await save({ siteUrl: 'https://source.example/path' });
      assert.equal(saved.status, 303);
      assert.equal(saved.headers.get('location'), '/site/?from=settings');
      shared = await readJson(path);
      const getState = async () => await (await fetch(stack.origin + '/site/api/state', { headers })).json();
      let state = await getState();
      assert.equal(state.siteUrl, 'https://source.example/path');
      saved = await save({ name: 'Updated' });
      assert.equal(saved.status, 303);
      shared = await readJson(path);
      assert.equal(shared.siteUrl, 'https://source.example/path');
      const staleRevision = revision(shared);
      saved = await save({ siteUrl: '' });
      assert.equal(saved.status, 303);
      shared = await readJson(path);
      assert.equal((await getState()).siteUrl, '');
      assert.equal((await save({ siteUrl: 'https://stale.example/' }, staleRevision)).status, 409);
      assert.equal((await readJson(path)).siteUrl, '');
      saved = await save({ siteUrl: 'javascript:alert(1)' });
      assert.equal(saved.status, 422);
      assert.match(await saved.text(), /href="\/site\/\?from=settings"><svg[^]*?<\/svg>Zpět/);
      assert.equal((await readJson(path)).siteUrl, '');
      const oldWrite = await fetch(stack.origin + '/site/api/settings', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteUrl: 'https://legacy-write.example/',
          roles: state.roles,
          imageModels: state.imageModels,
          keys: {},
        }),
      });
      assert.equal(oldWrite.status, 400);
      assert.match((await oldWrite.json()).error, /společném nastavení/);
      assert.equal(await readFile(legacyPath, 'utf8'), legacyBefore);
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.context().addCookies([{ name: sessionCookie(stack.origin), value: cookie.split('=')[1], url: stack.origin }]);
      await page.goto(stack.origin + '/settings?returnTo=%2Fsite%2F');
      await page.getByRole('textbox', { name: 'Adresa skutečného webu', exact: true }).fill('https://source.example/');
      await page.getByRole('button', { name: 'Uložit', exact: true }).click();
      await page.waitForURL(stack.origin + '/site/');
      studio = await studioFrame(page, 'site');
      await studio.waitForFunction(() => !document.getElementById('settings-button').disabled);
      if (!(await studio.locator('#settings').isVisible())) await openAiSettings(studio);
      assert.equal(await studio.locator('#site-url').count(), 0);
      assert.equal((await getState()).siteUrl, 'https://source.example/');
      assert.equal(await readFile(legacyPath, 'utf8'), legacyBefore);
    } finally {
      if (browser) await browser.close();
      await stack.close();
    }
  },
);
