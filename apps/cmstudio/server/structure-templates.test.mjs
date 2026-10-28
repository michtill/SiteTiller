import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { Store } from './store.ts';
// Structure templates (documentation 3.9) and the cycle rule of a link to the own collection (3.8).
async function editor(root, language = 'cs') {
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(
    join(root, 'settings/shared.json'),
    JSON.stringify({ name: 'Modrý Kocour', theme: 'green', language }),
  );
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      SITETILLER_INSTANCE_ROOT: root,
      CMS_DIST: fileURLToPath(new URL('../dist', import.meta.url)),
      SITETILLER_PRODUCTION_ROOT: join(root, '.production'),
      SITETILLER_SHARED_SETTINGS_FILE: join(root, 'settings/shared.json'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  let boot;
  for (let i = 0; i < 80 && !boot; i++) {
    try {
      const r = await fetch(origin + '/api/bootstrap');
      if (r.ok) boot = await r.json();
    } catch {}
    if (!boot) await new Promise((r) => setTimeout(r, 50));
  }
  if (!boot) child.kill();
  assert.ok(boot);
  const call = async (path, body, method = 'POST') => {
    const r = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'X-CMS-Token': boot.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const stop = async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  };
  return { origin, call, stop };
}
async function emptyInstance(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const dir of ['schema', 'data', 'media']) await mkdir(join(root, dir));
  await writeFile(join(root, 'schema/structure.json'), JSON.stringify({ version: 1, folders: {}, lists: {} }));
  return root;
}
test('ED-21: templates create the structure with prepared entries in one write, names in the interface language, codes the same; a used code replaces nothing', async () => {
  const root = await emptyInstance('structure-templates-');
  let app;
  try {
    app = await editor(root);
    let offer = (await app.call('/api/structure-templates', undefined, 'GET')).body.templates;
    assert.deepEqual(
      offer.map((item) => [item.id, item.available]),
      [
        ['contacts', true],
        ['elements', true],
        ['pages', true],
        ['images', true],
      ],
    );
    const before = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    // A stale structure revision creates nothing.
    assert.equal(
      (await app.call('/api/structure-templates', { ids: ['contacts'], schemaRevision: '0'.repeat(64) })).status,
      409,
    );
    const created = await app.call('/api/structure-templates', {
      ids: ['contacts', 'pages'],
      schemaRevision: before.schemaRevision,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const schema = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
    assert.deepEqual(Object.keys(schema.lists), ['contacts', 'pages']);
    assert.equal(schema.lists.contacts.label, 'Kontakty');
    // Codes are read only, entered only for a new entry.
    assert.equal(schema.lists.contacts.columns.code.readonly, true);
    assert.equal(schema.lists.pages.columns.parent.list, 'pages');
    assert.deepEqual(schema.lists.pages.group, ['parent']);
    // Pages bring the images folder.
    assert.deepEqual(schema.folders.images, { label: 'Obrázky', type: 'img' });
    const contacts = JSON.parse(await readFile(join(root, 'data/contacts.json'), 'utf8'));
    assert.deepEqual(
      contacts.map((row) => [row.code, row.name, row.value]),
      [
        ['name', 'Jméno', ''],
        ['email', 'E-mail', ''],
        ['phone', 'Telefon', ''],
        ['address', 'Adresa', ''],
        ['opening-hours', 'Otevírací doba', ''],
        ['map', 'Mapa', ''],
      ],
    );
    // The prepared Home page has the address home (the page key) and the address field its hint.
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/pages.json'), 'utf8')).map((row) => [row.slug, row.title]),
      [['home', 'Úvod']],
    );
    assert.equal(schema.lists.pages.columns.slug.label, 'Adresa stránky');
    assert.match(schema.lists.pages.columns.slug.hint, /Malá písmena, čísla a pomlčky/);
    // Only what is still free is offered; a used code is refused and nothing changes.
    offer = (await app.call('/api/structure-templates', undefined, 'GET')).body.templates;
    assert.deepEqual(
      offer.filter((item) => item.available).map((item) => item.id),
      ['elements', 'images'],
    );
    const now = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    const refused = await app.call('/api/structure-templates', {
      ids: ['contacts'],
      schemaRevision: now.schemaRevision,
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Kód contacts už používá „Kontakty“/);
    // A folder used by a field stays, and the error names the field.
    const noImages = structuredClone(schema);
    delete noImages.folders.images;
    const folder = await app.call('/api/structure', { schema: noImages, revision: now.schemaRevision }, 'PUT');
    assert.equal(folder.status, 422);
    assert.match(folder.body.error, /Složku „Obrázky“ nelze odstranit: používá ji pole Stránky \/ Obrázek/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8')), schema);
    await app.stop();
    // In English the names are English, the codes the same.
    app = await editor(root, 'en');
    const later = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    assert.equal(
      (await app.call('/api/structure-templates', { ids: ['elements'], schemaRevision: later.schemaRevision })).status,
      200,
    );
    const next = JSON.parse(await readFile(join(root, 'schema/structure.json'), 'utf8'));
    assert.equal(next.lists.elements.label, 'Website elements');
    assert.equal(next.lists.contacts.label, 'Kontakty');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/elements.json'), 'utf8')).map((row) => [row.code, row.name]),
      [
        ['title', 'Website title'],
        ['motto', 'Motto'],
        ['main-photo', 'Main photo'],
        ['hero-text', 'Hero text'],
        ['footer', 'Footer'],
        ['site-icon', 'Website icon'],
      ],
    );
  } finally {
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test('ED-21: the empty Content editor offers the templates; Create opens the new collection with its prepared entries', async () => {
  const root = await emptyInstance('structure-templates-ui-');
  let app, browser;
  try {
    app = await editor(root);
    browser = await chromium.launch({
      ...(process.env.SITETILLER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SITETILLER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(app.origin);
    const picker = page.getByRole('region', { name: 'Začněte šablonou' });
    await picker.waitFor();
    await picker.getByRole('checkbox', { name: /^Kontakty/ }).check();
    await picker.getByRole('button', { name: 'Založit' }).click();
    await page.getByText('Šablony jsou založené.').waitFor();
    await page.locator('.record-select', { hasText: 'Jméno' }).waitFor();
    assert.equal(await page.locator('.record-select').count(), 6);
    assert.equal(await picker.count(), 0);
  } finally {
    await browser?.close();
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test('ED-22: a parent in the own collection never makes a cycle, for every writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parent-cycle-'));
  try {
    for (const dir of ['schema', 'data', 'media']) await mkdir(join(root, dir));
    await writeFile(
      join(root, 'schema/structure.json'),
      JSON.stringify({
        version: 1,
        folders: {},
        lists: {
          pages: {
            label: 'Pages',
            key: 'slug',
            display: 'title',
            columns: {
              slug: { label: 'Slug', type: 'text', required: true },
              title: { label: 'Title', type: 'text' },
              parent: { label: 'Parent page', type: 'list', list: 'pages' },
            },
          },
        },
      }),
    );
    const rows = [
      { slug: 'home', title: 'Úvod', parent: '' },
      { slug: 'contact', title: 'Kontakt', parent: 'home' },
      { slug: 'map', title: 'Mapa', parent: 'contact' },
    ];
    await writeFile(join(root, 'data/pages.json'), JSON.stringify(rows));
    // validateRows is the check every write goes through (form, AI Studio, MCP, templates).
    const store = new Store(root);
    assert.equal((await store.validateRows('pages', rows, { pages: rows })).length, 3);
    await assert.rejects(
      store.validateRows('pages', [{ ...rows[0], parent: 'home' }, rows[1], rows[2]], { pages: rows }),
      /Úvod nemůže být pod sebou samou/,
    );
    const cycle = [{ ...rows[0], parent: 'map' }, rows[1], rows[2]];
    await assert.rejects(
      store.validateRows('pages', cycle, { pages: cycle }),
      /Úvod nemůže být pod Mapa, protože Mapa je pod Úvod/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ED-23: renaming a linked key in the form updates every link in one write; without the explicit rename it is refused', async () => {
  const root = await emptyInstance('key-rename-');
  let app;
  try {
    app = await editor(root);
    const boot = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    assert.equal(
      (await app.call('/api/structure-templates', { ids: ['pages'], schemaRevision: boot.schemaRevision })).status,
      200,
    );
    const now = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    let list = now.lists.pages;
    const save = (rows, rename) =>
      app.call(
        '/api/lists/pages',
        { rows, revision: list.revision, schemaRevision: now.schemaRevision, ...(rename ? { rename } : {}) },
        'PUT',
      );
    let saved = await save([...list.rows, { slug: 'kontakt', title: 'Kontakt', parent: 'home' }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    list = saved.body;
    // A whole-collection write (as from the AI Studio or MCP) cannot tell a rename from a deletion: refused.
    const plain = list.rows.map((row) => (row.slug === 'home' ? { ...row, slug: 'uvod' } : row));
    const refused = await save(plain);
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /odkazovaná položka neexistuje|nelze odstranit nebo přejmenovat/);
    // The form's explicit rename takes the links along.
    saved = await save(plain, { from: 'home', to: 'uvod' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.renamedLinks, true);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/pages.json'), 'utf8')).map((row) => [row.slug, row.parent]),
      [
        ['uvod', ''],
        ['kontakt', 'uvod'],
      ],
    );
    // Deleting a linked page stays impossible.
    list = saved.body;
    const deleted = await save(list.rows.filter((row) => row.slug !== 'uvod'));
    assert.equal(deleted.status, 422);
  } finally {
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test('ED-24: an Editor page left open across a restart still saves: the write token stays the same', async () => {
  const root = await emptyInstance('editor-token-');
  let app;
  try {
    app = await editor(root);
    const first = (await app.call('/api/bootstrap', undefined, 'GET')).body.token;
    await app.stop();
    app = await editor(root);
    const second = (await app.call('/api/bootstrap', undefined, 'GET')).body;
    assert.equal(second.token, first);
    const r = await fetch(app.origin + '/api/structure-templates', {
      method: 'POST',
      headers: { Origin: app.origin, 'X-CMS-Token': first, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['images'], schemaRevision: second.schemaRevision }),
    });
    assert.equal(r.status, 200);
  } finally {
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
