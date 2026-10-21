import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
// Shared previews (documentation 4.10) on one instance; the scenarios run in order on it.
let stack, cookie, publicHost;
const shares = () => readFile(join(stack.root, 'settings/shares.json'), 'utf8').then(JSON.parse);
// The public preview address is localhost:<Shell port>; the request goes to the Shell with that host name.
function pub(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: stack.ports.shell, path, method, headers: { host: publicHost, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const signedIn = (path, init = {}) =>
  fetch(stack.origin + path, {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: stack.origin,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    redirect: 'manual',
  });
const ai = async (path, body) => {
  const r = await signedIn('/site/api/' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const value = await r.json();
  if (!r.ok) throw Error(value.error);
  return value;
};
async function share(body) {
  const r = await signedIn('/__shell/shares', { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}
const path = (url) => new URL(url).pathname;
// The public preview switch on Settings → Addresses and sharing.
async function publicPreview(on) {
  const html = await (await signedIn('/settings/addresses')).text();
  const form = new URLSearchParams({
    returnTo: '/site/',
    action: 'preview',
    revision: html.match(/name="revision" value="([^"]*)"/)[1],
    ...(on ? { publicPreview: 'on' } : {}),
  });
  const r = await fetch(stack.origin + '/settings/addresses', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: stack.origin },
    body: form,
  });
  assert.equal(r.status, 200);
}
async function renameHome(title) {
  const bootstrap = await (await signedIn('/content/api/bootstrap')).json(),
    rows = bootstrap.lists.pages.rows.map((row) => ({ ...row, title }));
  const r = await signedIn('/content/api/lists/pages', {
    method: 'PUT',
    headers: { 'x-cms-token': bootstrap.token },
    body: JSON.stringify({ rows, revision: bootstrap.lists.pages.revision, schemaRevision: bootstrap.schemaRevision }),
  });
  assert.equal(r.status, 200);
}
before(async () => {
  stack = await isolatedStack();
  publicHost = 'localhost:' + stack.ports.shell;
  const r = await fetch(stack.origin + '/login', {
    method: 'POST',
    headers: { Origin: stack.origin },
    body: new URLSearchParams({ password: stack.password }),
    redirect: 'manual',
  });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await stack?.close();
});
let first, draft, release;

test(
  'SD-01: a shared step shows its state from the moment of sharing; later content and steps do not change it',
  { timeout: 120000 },
  async () => {
    assert.equal((await share({ kind: 'step' })).status, 409);
    await publicPreview(true);
    await renameHome('Sdílený nadpis');
    first = await share({ kind: 'step', validity: '7d' });
    assert.equal(first.status, 200);
    assert.match(first.url, new RegExp('^http://' + publicHost + '/s/[a-f0-9]{64}/$'));
    assert.ok(Math.abs(Date.parse(first.expires) - Date.now() - 7 * 86400000) < 60000);
    await renameHome('Pozdější nadpis');
    const shared = await pub(path(first.url)),
      live = await pub('/');
    assert.equal(shared.status, 200);
    assert.match(shared.text, /Sdílený nadpis/);
    assert.doesNotMatch(shared.text, /Pozdější nadpis/);
    assert.match(live.text, /Pozdější nadpis/);
    assert.deepEqual((await ai('state')).savedDrafts, []);
  },
);

test(
  'SD-02: a shared saved draft and version show exactly that state and nothing else of the instance',
  { timeout: 180000 },
  async () => {
    const state = await ai('state');
    await ai('drafts/save', { name: 'Varianta pro klienta', expectedHead: state.head, cmsSource: 'unpublished' });
    draft = (await ai('state')).savedDrafts.at(-1);
    const draftShare = await share({ kind: 'draft', draftId: draft.id });
    assert.equal(draftShare.label, 'Uložený návrh Varianta pro klienta');
    assert.match((await pub(path(draftShare.url))).text, /Pozdější nadpis/);
    await renameHome('Publikovaný nadpis');
    // A version needs a step that changes the website: one written as an assistant's step.
    await ai('assistant-step', {
      assistant: 'Test',
      summary: 'Poznámka pro verzi',
      files: [{ path: 'site/poznamka.txt', text: 'Verze ke sdílení' }],
    });
    const now = await ai('state');
    await ai('publish', {
      cmsSource: 'unpublished',
      confirmCmsPublication: true,
      commit: now.head,
      expectedHead: now.head,
      description: 'Verze ke sdílení',
    });
    release = (await ai('state')).releases.at(-1);
    const releaseShare = await share({ kind: 'release', releaseId: release.id });
    assert.equal(releaseShare.label, 'Verze ' + release.number);
    const page = await pub(path(releaseShare.url));
    assert.match(page.text, /Publikovaný nadpis/);
    const ids = (await shares()).map((s) => s.id);
    for (const value of [release.commit, ...ids]) assert.ok(!page.text.includes(value));
    const base = path(releaseShare.url);
    for (const other of [
      base + 'versions/' + now.head + '/',
      base + 'shares/' + ids[0] + '/',
      '/s/' + 'a'.repeat(64) + '/',
      '/site/',
      '/content/',
      '/settings',
      '/versions/' + now.head + '/',
      base + '..%2f..%2fsettings',
    ])
      assert.equal((await pub(other)).status, 404, other);
    assert.equal((await pub(base.slice(0, -1))).status, 302);
  },
);

// The Share dialog's list: the links to one state.
const listFor = async (source) =>
  (await (await signedIn('/__shell/shares?' + new URLSearchParams(source))).json()).shares;
const revoke = (id) => signedIn('/__shell/shares/revoke', { method: 'POST', body: JSON.stringify({ id }) });

test(
  'SD-03: the Share dialog lists the links to its state; expired and revoked links answer 404; the public preview switch stops and restores them',
  { timeout: 60000 },
  async () => {
    // Settings → Shared previews: every valid link in one table.
    const page = await (await signedIn('/settings/addresses')).text();
    for (const link of [
      ...(await listFor({ kind: 'draft', draftId: draft.id })),
      ...(await listFor({ kind: 'release', releaseId: release.id })),
    ])
      assert.ok(page.includes('value="' + link.url + '"'), link.url);
    const forDraft = await listFor({ kind: 'draft', draftId: draft.id });
    assert.equal(forDraft.length, 1);
    assert.match(forDraft[0].url, /\/s\/[a-f0-9]{64}\/$/);
    assert.equal(forDraft[0].createdBy, 'Uživatel');
    assert.ok(Date.parse(forDraft[0].expires) > Date.now() + 29 * 86400000);
    assert.equal((await listFor({ kind: 'release', releaseId: release.id })).length, 1);
    await publicPreview(false);
    assert.equal((await pub(path(forDraft[0].url))).status, 404);
    await publicPreview(true);
    assert.equal((await pub(path(forDraft[0].url))).status, 200);
    // Expiry: the stored date passes.
    const stored = await shares();
    stored.find((s) => s.id === forDraft[0].id).expires = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(stack.root, 'settings/shares.json'), JSON.stringify(stored));
    assert.equal((await pub(path(forDraft[0].url))).status, 404);
    assert.deepEqual(await listFor({ kind: 'draft', draftId: draft.id }), []);
    const one = await share({ kind: 'draft', draftId: draft.id, validity: 'none' });
    assert.equal(one.expires, null);
    const [row] = await listFor({ kind: 'draft', draftId: draft.id });
    assert.equal(row.expires, null);
    assert.equal((await revoke(row.id)).status, 200);
    assert.equal((await pub(path(one.url))).status, 404);
    assert.deepEqual(await listFor({ kind: 'draft', draftId: draft.id }), []);
    // Revoke all on the settings page asks first; only the confirmation revokes.
    const two = await share({ kind: 'draft', draftId: draft.id }),
      revokeAll = (values) =>
        fetch(stack.origin + '/settings/addresses', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: stack.origin },
          body: new URLSearchParams({ action: 'revokeAll', ...values }),
        });
    const asked = await (await revokeAll({})).text();
    assert.match(asked, /Opravdu zrušit všechny sdílené odkazy \(\d+\)\?/);
    assert.equal((await pub(path(two.url))).status, 200);
    await revokeAll({ confirm: 'yes' });
    assert.equal((await pub(path(two.url))).status, 404);
    assert.deepEqual(await shares(), []);
    release.link = await share({ kind: 'release', releaseId: release.id });
  },
);

test(
  'SD-04: only reading, no indexing, the whole link is kept; deleting the step or saved draft ends its links, a version link stays',
  { timeout: 120000 },
  async () => {
    const shared = await share({ kind: 'draft', draftId: draft.id }),
      p = path(shared.url);
    assert.equal(
      (await pub(p, { method: 'POST', headers: { origin: 'http://' + publicHost }, body: 'x=1' })).status,
      404,
    );
    assert.equal((await pub(p, { method: 'PUT' })).status, 404);
    assert.equal((await pub(p, { method: 'HEAD' })).status, 200);
    const page = await pub(p);
    assert.match(page.headers['x-robots-tag'], /noindex/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal((await pub('/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
    // The whole link is kept so it can be copied again; only the instance may read the file.
    assert.ok((await shares()).some((s) => shared.url.endsWith('/s/' + s.code + '/')));
    if (process.platform !== 'win32')
      assert.equal(
        (await (await import('node:fs/promises')).stat(join(stack.root, 'settings/shares.json'))).mode & 0o777,
        0o600,
      );
    // Deleting the saved draft ends its link.
    let state = await ai('state');
    await ai('drafts/remove', { id: draft.id, commit: draft.commit, expectedHead: state.head });
    assert.equal((await pub(p)).status, 404);
    assert.deepEqual(await listFor({ kind: 'draft', draftId: draft.id }), []);
    // A step's link ends when "Remove previous steps" discards the step.
    await ai('assistant-step', {
      assistant: 'Test',
      summary: 'Krok ke sdílení',
      files: [{ path: 'site/krok.txt', text: 'krok' }],
    });
    state = await ai('state');
    const step = state.requests.at(-1),
      stepShare = await share({ kind: 'step', stepId: step.id, commit: step.commit });
    assert.equal(stepShare.label, 'Krok ' + step.sequence);
    assert.equal((await listFor({ kind: 'step', stepId: step.id })).length, 1);
    assert.equal((await pub(path(stepShare.url))).status, 200);
    await ai('drafts/save', { name: 'Po kroku', expectedHead: state.head, commit: step.commit, clearPrevious: true });
    assert.equal((await pub(path(stepShare.url))).status, 404);
    assert.deepEqual(await listFor({ kind: 'step', stepId: step.id }), []);
    // A version cannot be deleted; its link stays.
    const [versionLink] = await listFor({ kind: 'release', releaseId: release.id });
    assert.equal((await pub(path(versionLink.url))).status, 200);
  },
);

test(
  'SD-05: an MCP assistant with Edit the draft shares a step under its name, lists the links and revokes one; without it, or with the public preview off, an exact error',
  { timeout: 60000 },
  async () => {
    const form = (values) =>
      fetch(stack.origin + '/settings/mcp', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: stack.origin },
        body: new URLSearchParams(values),
      });
    await form({ action: 'save', enabled: 'on', edit: 'on' });
    const token = (await (await form({ action: 'token', tokenName: 'Claude Code' })).text()).match(
      /value="(st_[a-f0-9]{64})"/,
    )[1];
    const call = async (args, name = 'share_preview') => {
      const r = await fetch(stack.origin + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return (await r.json()).result;
    };
    let result = await call({ validity: '1d' });
    assert.equal(result.isError, false);
    assert.match(result.structuredContent.url, /\/s\/[a-f0-9]{64}\/$/);
    assert.equal((await pub(path(result.structuredContent.url))).status, 200);
    const state = await ai('state'),
      latest = state.requests.findLast((r) => r.commit === state.head),
      listed = await listFor(latest ? { kind: 'step', stepId: latest.id } : { kind: 'step', commit: state.head });
    assert.ok(listed.some((s) => s.createdBy === 'Asistent (Claude Code)' && s.url === result.structuredContent.url));
    // The assistant sees every valid link and revokes any of them; the link stops working at once.
    const url = result.structuredContent.url,
      mine = (await call({}, 'list_shares')).structuredContent.shares.find((s) => s.url === url);
    assert.equal(mine.created_by, 'Asistent (Claude Code)');
    result = await call({ id: mine.id }, 'revoke_share');
    assert.equal(result.isError, false);
    assert.equal((await pub(path(url))).status, 404);
    assert.ok(!(await call({}, 'list_shares')).structuredContent.shares.some((s) => s.id === mine.id));
    assert.match((await call({ id: mine.id }, 'revoke_share')).content[0].text, /Sdílený odkaz neexistuje/);
    await publicPreview(false);
    result = await call({});
    assert.match(result.content[0].text, /Sdílení vyžaduje zapnutý veřejný náhled/);
    await publicPreview(true);
    await form({ action: 'save', enabled: 'on' });
    result = await call({});
    assert.match(result.content[0].text, /nemá oprávnění Upravovat návrh/);
    assert.match((await call({ id: 'x' }, 'revoke_share')).content[0].text, /nemá oprávnění Upravovat návrh/);
    assert.equal((await call({}, 'list_shares')).isError, false);
  },
);
