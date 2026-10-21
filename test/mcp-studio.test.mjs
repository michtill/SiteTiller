import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedStack } from './support/stack.mjs';
// MCP can do everything the AI Studio can (documentation 2.8): structure, content files, steps, drafts, versions,
// publication options and the live website. The scenarios run in order on one instance.
let stack, cookie, token, form;
const page = (text) =>
  `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text}</title></head><body><main><h1>${text}</h1></main></body></html>`;
const signedIn = (path) => fetch(stack.origin + path, { headers: { Cookie: cookie } }).then((r) => r.json());
async function call(name, args = {}) {
  const r = await fetch(stack.origin + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = (await r.json()).result;
  return { error: result.isError ? result.content[0].text : '', value: result.structuredContent };
}
async function ok(name, args) {
  const result = await call(name, args);
  assert.equal(result.error, '', name);
  return result.value;
}
// Publishing: under load the Publisher may confirm later; the tool then says it is finishing internally and the
// version appears once it is done (documentation 2.8). The test waits for it like the assistant would.
async function publish(args) {
  const before = (await signedIn('/site/api/state')).releases.length,
    result = await ok('publish_step', args);
  if (result.version) return result;
  assert.equal(result.publishing, true);
  for (let i = 0; i < 240; i++) {
    const releases = (await signedIn('/site/api/state')).releases;
    if (releases.length > before) {
      const release = releases.at(-1);
      return {
        version: release.number + (release.minor !== undefined ? '.' + release.minor : ''),
        commit: release.commit,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('The publication did not finish');
}
const step = async (path, text) =>
  (await ok('write_site_files', { summary: 'Stránka ' + text, files: [{ path, text: page(text) }] })).commit;
before(async () => {
  stack = await isolatedStack({
    controllerImports: ['test/fixtures/live-website-snapshot.mjs', 'test/fixtures/redirect-to-internal.mjs'],
  });
  const r = await fetch(stack.origin + '/login', {
    method: 'POST',
    headers: { Origin: stack.origin },
    body: new URLSearchParams({ password: stack.password }),
    redirect: 'manual',
  });
  cookie = r.headers.get('set-cookie').split(';')[0];
  form = (values) =>
    fetch(stack.origin + '/settings/mcp', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: stack.origin },
      body: new URLSearchParams(values),
    });
  await form({ action: 'save', enabled: 'on', edit: 'on', delete: 'on', publish: 'on' });
  token = (await (await form({ action: 'token', tokenName: 'Claude' })).text()).match(/value="(st_[a-f0-9]{64})"/)[1];
});
after(async () => {
  await stack?.close();
});

test(
  'MC-07: the assistant adds a field with its values, uploads a content file; an invalid or stale structure is refused',
  { timeout: 60000 },
  async () => {
    const content = await ok('read_content'),
      schema = structuredClone(content.schema);
    schema.lists.pages.columns.spotify = { type: 'text', label: 'Spotify' };
    const rows = content.collections.pages.rows.map((row) => ({
      ...row,
      spotify: 'https://open.spotify.com/album/example',
    }));
    const written = await ok('write_structure', {
      schema,
      collections: { pages: rows },
      schema_revision: content.schema_revision,
      content_revision: content.content_revision,
    });
    assert.notEqual(written.schema_revision, content.schema_revision);
    const bootstrap = await signedIn('/content/api/bootstrap');
    assert.equal(bootstrap.schema.lists.pages.columns.spotify.label, 'Spotify');
    assert.equal(bootstrap.lists.pages.rows[0].spotify, 'https://open.spotify.com/album/example');
    assert.equal((await signedIn('/content/api/publication')).unpublished, true);
    // The old revisions are stale now.
    assert.notEqual(
      (
        await call('write_structure', {
          schema,
          schema_revision: content.schema_revision,
          content_revision: content.content_revision,
        })
      ).error,
      '',
    );
    const fresh = await ok('read_content'),
      broken = structuredClone(fresh.schema);
    broken.lists.pages.columns.spotify = { type: 'no-such-type', label: 'Spotify' };
    assert.notEqual(
      (
        await call('write_structure', {
          schema: broken,
          schema_revision: fresh.schema_revision,
          content_revision: fresh.content_revision,
        })
      ).error,
      '',
    );
    await ok('upload_content_file', {
      folder: 'files',
      name: 'od-asistenta.txt',
      base64: Buffer.from('Soubor od asistenta').toString('base64'),
    });
    const media = JSON.stringify((await signedIn('/content/api/bootstrap')).media);
    assert.match(media, /od-asistenta\.txt/);
  },
);

test(
  'MC-08: the assistant saves a draft, returns to a step, deletes the last step, loads and deletes a saved draft like the AI Studio buttons',
  { timeout: 180000 },
  async () => {
    const a = await step('site/a.html', 'Krok A'),
      b = await step('site/b.html', 'Krok B');
    let state = await signedIn('/site/api/state');
    assert.equal(state.head, b);
    const saved = await ok('save_draft', { name: 'Návrh A', commit: a, clear_previous: false });
    assert.equal(saved.name, 'Návrh A');
    // A private link to the saved draft shows its state after signing in.
    const draftLink = (await ok('preview_link', { saved_draft_id: saved.id })).url;
    assert.ok(draftLink.startsWith(stack.origin + '/preview/drafts/' + saved.id + '/access/'));
    assert.equal((await fetch(draftLink + 'a.html', { redirect: 'manual' })).status, 303);
    assert.match(await (await fetch(draftLink + 'a.html', { headers: { Cookie: cookie } })).text(), /Krok A/);
    assert.match((await call('preview_link', { saved_draft_id: 'draft-' + '0'.repeat(32) })).error, /neexistuje/);
    await ok('return_to_step', { commit: a });
    state = await signedIn('/site/api/state');
    assert.equal(state.head, a);
    assert.ok(!state.requests.some((r) => r.commit === b));
    const c = await step('site/c.html', 'Krok C');
    assert.equal((await signedIn('/site/api/state')).head, c);
    await ok('delete_last_step');
    assert.equal((await signedIn('/site/api/state')).head, a);
    const savedCommit = (await signedIn('/site/api/state')).savedDrafts.find((d) => d.id === saved.id).commit;
    await ok('load_into_draft', { saved_draft_id: saved.id, clear_all: true });
    state = await signedIn('/site/api/state');
    // Loaded with Remove all draft changes: one step, the loaded saved draft.
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].restoredFrom, savedCommit);
    assert.equal(state.head, savedCommit);
    await ok('delete_saved_draft', { id: saved.id });
    assert.ok(!(await signedIn('/site/api/state')).savedDrafts.some((d) => d.id === saved.id));
    assert.match((await call('delete_saved_draft', { id: saved.id })).error, /neexistuje/);
  },
);

test(
  'MC-09: the assistant publishes with a description and Remove previous steps, then a subversion, and loads a version back',
  { timeout: 240000 },
  async () => {
    await step('site/verze.html', 'Verze od asistenta');
    const first = await publish({ description: 'MCP verze', include_unpublished_content: true });
    let state = await signedIn('/site/api/state');
    const release = state.releases.at(-1);
    assert.equal(release.description, 'MCP verze');
    assert.equal(String(release.number), first.version);
    assert.equal(state.requests[0].firstStep, 'published');
    await step('site/subverze.html', 'Subverze');
    const sub = await publish({ description: 'Oprava', create_subversion: true });
    assert.equal(sub.version, release.number + '.1');
    state = await signedIn('/site/api/state');
    const before = state.requests.length;
    await step('site/navic.html', 'Navíc');
    await ok('load_into_draft', { release_id: release.id, clear_all: false });
    state = await signedIn('/site/api/state');
    assert.ok(state.requests.length > before);
  },
);

test(
  'MC-11: without Delete steps and drafts the assistant deletes nothing and gets an exact error; with it the deletion goes through',
  { timeout: 180000 },
  async () => {
    await form({ action: 'save', enabled: 'on', edit: 'on', publish: 'on' });
    const a = await step('site/mazani-a.html', 'Mazání A'),
      b = await step('site/mazani-b.html', 'Mazání B');
    const saved = await ok('save_draft', { name: 'Bez mazání' });
    let state = await signedIn('/site/api/state');
    // Saving without the option keeps the steps.
    assert.equal(state.head, b);
    assert.ok(state.requests.some((r) => r.commit === a) && state.requests.some((r) => r.commit === b));
    const denied = /nemá oprávnění Mazat kroky a návrhy/;
    for (const [name, args] of [
      ['delete_last_step', {}],
      ['delete_saved_draft', { id: saved.id }],
      ['return_to_step', { commit: a }],
      ['load_into_draft', { saved_draft_id: saved.id, clear_all: true }],
      ['save_draft', { name: 'S mazáním', clear_previous: true }],
      ['publish_step', { clear_previous: true }],
    ])
      assert.match((await call(name, args)).error, denied, name);
    state = await signedIn('/site/api/state');
    assert.equal(state.head, b);
    assert.ok(state.savedDrafts.some((d) => d.id === saved.id));
    assert.equal(state.savedDrafts.filter((d) => d.name === 'S mazáním').length, 0);
    await form({ action: 'save', enabled: 'on', edit: 'on', delete: 'on', publish: 'on' });
    await ok('delete_last_step');
    assert.equal((await signedIn('/site/api/state')).head, a);
    await ok('delete_saved_draft', { id: saved.id });
    assert.ok(!(await signedIn('/site/api/state')).savedDrafts.some((d) => d.id === saved.id));
  },
);

test(
  'MC-10: the assistant compares the draft with the live website at another address and loads it into the draft; internal addresses are refused',
  { timeout: 180000 },
  async () => {
    // Another public address than the published website, while the draft already has steps; its files come from the
    // hosting stand-in.
    await step('site/jen-v-navrhu.html', 'Jen v návrhu');
    // Internal addresses are refused before anything is downloaded; the draft does not change.
    const head = (await signedIn('/site/api/state')).head;
    for (const url of [
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://169.254.169.254/latest/meta-data/',
      // A public website that redirects into the internal network.
      'http://redirect.example.test/',
    ])
      assert.match(
        (await call('compare_live_website', { url })).error,
        /Soukromé a interní síťové adresy nelze načítat/,
        url,
      );
    for (const url of ['http://localhost/', 'http://example.org:8080/'])
      assert.match((await call('compare_live_website', { url })).error, /veřejnou HTTP\/HTTPS adresu/, url);
    assert.equal((await signedIn('/site/api/state')).head, head);
    const compared = await ok('compare_live_website', { url: 'https://web.example.test/' });
    assert.equal(compared.url, 'https://web.example.test/');
    assert.equal(compared.equal, false);
    assert.ok(compared.changes.some((c) => c.path.includes('jen-v-navrhu') && c.status === 'only-draft'));
    const before = (await signedIn('/site/api/state')).head;
    const loaded = await ok('load_live_website', { token: compared.token });
    const state = await signedIn('/site/api/state');
    assert.equal(state.head, loaded.commit);
    assert.notEqual(state.head, before);
    // The step holds the live website.
    assert.match((await ok('read_site_file', { path: 'site/index.html' })).text, /Živý web z hostingu/);
    // The loaded step keeps the draft's saved content, so a later step can be deleted back to it.
    assert.ok((await ok('list_site_files')).files.length);
    await step('site/po-nacteni.html', 'Po načtení');
    await ok('delete_last_step');
    assert.equal((await signedIn('/site/api/state')).head, loaded.commit);
  },
);

test(
  'MC-12: MCP limits: strict stops the step, key checks write it with warnings and stop publication only on what breaks the website, no checks publish anyway; content data stay protected',
  { timeout: 300000 },
  async () => {
    const limits = (checks) => form({ action: 'save', enabled: 'on', edit: 'on', delete: 'on', publish: 'on', checks });
    const untitled = (path) => ({
      summary: 'Stránka bez názvu',
      files: [{ path, text: page('Bez názvu').replace(/<title>.*<\/title>/, '') }],
    });
    await limits('strict');
    assert.match((await call('write_site_files', untitled('site/bez-nazvu.html'))).error, /Chybí název stránky/);
    await limits('key');
    const warned = await ok('write_site_files', untitled('site/bez-nazvu.html'));
    assert.equal(warned.checks, 'warnings');
    // Not key: the publication goes through, with the checks as warnings.
    const published = await publish({ description: 'S upozorněním' });
    assert.ok(published.version);
    // A broken form definition is key: the publication stops.
    await ok('write_site_files', {
      summary: 'Rozbitý formulář',
      files: [{ path: 'site/forms.json', text: '{"rozbito": ' }],
    });
    assert.match((await call('publish_step', {})).error, /Publikování zastaveno/);
    await limits('none');
    const unchecked = await ok('write_site_files', untitled('site/dalsi-bez-nazvu.html'));
    assert.equal(unchecked.checks, 'passed');
    await ok('write_site_files', { summary: 'Oprava formuláře', remove: ['site/forms.json'] });
    assert.ok((await publish({ description: 'Bez kontrol' })).version);
    // Content data are protected at every level.
    const content = await ok('read_content'),
      rows = content.collections.pages.rows;
    assert.notEqual(
      (
        await call('write_content', {
          collection: 'pages',
          rows: [...rows, rows[0]],
          revision: content.collections.pages.revision,
        })
      ).error,
      '',
    );
    await limits('strict');
  },
);
