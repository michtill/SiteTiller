import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedStack } from './support/stack.mjs';
// One instance for the MCP scenarios (documentation 2.8); they run in order on it.
let stack, cookie;
const seen = [];
before(async () => {
  stack = await isolatedStack();
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
const form = (path, values, extra = {}) =>
  fetch(stack.origin + path, {
    method: 'POST',
    headers: { Origin: stack.origin, Cookie: cookie, ...extra },
    body: new URLSearchParams(values),
    redirect: 'manual',
  });
const settings = (values) => form('/settings/mcp', { action: 'save', ...values });
async function rpc(token, method, params = {}) {
  const r = await fetch(stack.origin + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
async function call(token, name, args = {}) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  const result = r.body.result;
  return { error: result.isError ? result.content[0].text : '', value: result.structuredContent };
}
async function accessToken(name) {
  const r = await form('/settings/mcp', { action: 'token', tokenName: name });
  return (await r.text()).match(/value="(st_[a-f0-9]{64})"/)[1];
}
// The OAuth flow an assistant runs: registration with its name, sign-in with the instance password, PKCE exchange.
async function oauth(name, password = stack.password) {
  const redirect = 'https://assistant.example/callback';
  let r = await fetch(stack.origin + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
  });
  assert.equal(r.status, 201);
  const client = (await r.json()).client_id,
    verifier = randomBytes(32).toString('base64url'),
    challenge = createHash('sha256').update(verifier).digest('base64url'),
    params = {
      response_type: 'code',
      client_id: client,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'example-state',
    };
  r = await fetch(stack.origin + '/oauth/authorize?' + new URLSearchParams(params));
  assert.equal(r.status, 200);
  assert.match(await r.text(), new RegExp(name + ' chce přístup'));
  r = await fetch(stack.origin + '/oauth/authorize', {
    method: 'POST',
    headers: { Origin: stack.origin },
    body: new URLSearchParams({ ...params, action: 'allow', password }),
    redirect: 'manual',
  });
  if (r.status !== 303) return { status: r.status };
  const location = new URL(r.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 'example-state');
  const exchange = (code, codeVerifier) =>
    fetch(stack.origin + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: client,
        redirect_uri: redirect,
      }),
    });
  const code = location.searchParams.get('code');
  assert.equal((await exchange(code, 'wrong-verifier')).status, 400);
  // A code works once; the failed attempt above used it up, so ask again.
  r = await fetch(stack.origin + '/oauth/authorize', {
    method: 'POST',
    headers: { Origin: stack.origin },
    body: new URLSearchParams({ ...params, action: 'allow', password }),
    redirect: 'manual',
  });
  const second = new URL(r.headers.get('location')).searchParams.get('code');
  r = await exchange(second, verifier);
  assert.equal(r.status, 200);
  const tokens = await r.json();
  assert.equal((await exchange(second, verifier)).status, 400);
  return { status: 200, client, ...tokens };
}
const page = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ukázka asistenta</title></head><body><main><h1>Ukázka asistenta</h1><p>Text od asistenta.</p></main></body></html>`;

test('MC-01: MCP is off by default (404); switched on it reads and edits the draft; switching off disconnects everyone', async () => {
  assert.equal((await rpc('', 'initialize')).status, 404);
  assert.equal((await fetch(stack.origin + '/.well-known/oauth-authorization-server')).status, 404);
  assert.equal((await fetch(stack.origin + '/oauth/register', { method: 'POST', body: '{}' })).status, 404);
  const html = await (await fetch(stack.origin + '/settings/mcp', { headers: { Cookie: cookie } })).text();
  assert.match(html, /name="enabled"(?![^>]*checked)/);
  assert.match(html, /name="edit"[^>]*checked/);
  assert.match(html, /name="publish"(?![^>]*checked)/);
  assert.match(html, /<a href="\/settings\/mcp\?returnTo=[^"]*" aria-current="page">Připojte externí AI/);
  assert.equal((await settings({ enabled: 'on', edit: 'on' })).status, 200);
  const token = await accessToken('Claude Code');
  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.serverInfo.name, 'SiteTiller');
  const names = (await rpc(token, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    'get_overview',
    'list_site_files',
    'read_site_file',
    'read_content',
    'write_site_files',
    'write_content',
    'write_structure',
    'list_structure_templates',
    'apply_structure_templates',
    'upload_content_file',
    'return_to_step',
    'delete_last_step',
    'save_draft',
    'delete_saved_draft',
    'load_into_draft',
    'compare_live_website',
    'load_live_website',
    'preview_link',
    'share_preview',
    'list_shares',
    'revoke_share',
  ]);
  await settings({ edit: 'on' });
  assert.equal((await rpc(token, 'initialize')).status, 404);
  await settings({ enabled: 'on', edit: 'on' });
  assert.equal((await rpc(token, 'initialize')).status, 401);
});

test('MC-02: OAuth with the instance password and consent, a one-time access token, Disconnect and a password change revoke access', async () => {
  const unauthorized = await rpc('', 'initialize');
  assert.equal(unauthorized.status, 401);
  assert.match(
    unauthorized.headers.get('www-authenticate'),
    /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/,
  );
  assert.equal((await oauth('ChatGPT', 'wrong-password')).status, 401);
  const claude = await oauth('Claude');
  assert.equal((await rpc(claude.access_token, 'initialize')).status, 200);
  // Refresh gives new tokens.
  const refreshed = await (
    await fetch(stack.origin + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: claude.refresh_token,
        client_id: claude.client,
      }),
    })
  ).json();
  assert.equal((await rpc(refreshed.access_token, 'ping')).status, 200);
  // The access token is shown once; the settings list the assistants by name.
  const token = await accessToken('Claude Code');
  const html = await (await fetch(stack.origin + '/settings/mcp', { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(html, new RegExp(token));
  assert.match(html, /<strong>Claude<\/strong>/);
  assert.match(html, /<strong>Claude Code<\/strong>/);
  const stored = JSON.parse(await readFile(join(stack.root, 'settings/mcp.json'), 'utf8')),
    id = stored.connections.find((c) => c.name === 'Claude Code').id;
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(token.slice(3)));
  await form('/settings/mcp', { action: 'disconnect', id });
  assert.equal((await rpc(token, 'ping')).status, 401);
  assert.equal((await rpc(refreshed.access_token, 'ping')).status, 200);
  const changed = await form('/password', {
    currentPassword: stack.password,
    newPassword: 'example-mcp-password',
    confirmPassword: 'example-mcp-password',
  });
  assert.equal(changed.status, 200);
  assert.equal((await rpc(refreshed.access_token, 'ping')).status, 401);
  stack.password = 'example-mcp-password';
  const r = await fetch(stack.origin + '/login', {
    method: 'POST',
    headers: { Origin: stack.origin },
    body: new URLSearchParams({ password: stack.password }),
    redirect: 'manual',
  });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

test(
  'MC-03: website files become a step "Asistent (Claude)" with a preview; a failed check stops it, warn-only writes it with a warning',
  { timeout: 180000 },
  async () => {
    const { access_token: token } = await oauth('Claude');
    let r = await call(token, 'write_site_files', {
      summary: 'Přidat stránku ukázky',
      files: [{ path: 'site/ukazka.html', text: page }],
    });
    assert.equal(r.error, '');
    assert.equal(r.value.checks, 'passed');
    const step = r.value.step;
    const state = await (await fetch(stack.origin + '/site/api/state', { headers: { Cookie: cookie } })).json(),
      request = state.requests.find((q) => q.sequence === step);
    assert.equal(request.assistant, 'Claude');
    assert.equal(request.prompt, 'Přidat stránku ukázky');
    assert.equal(request.commit, state.head);
    assert.match(await (await fetch(state.previewUrl + 'ukazka.html')).text(), /Text od asistenta/);
    // A private preview link: it asks for the sign-in first and then opens the preview, like Open in the AI Studio.
    assert.equal(r.value.preview_url, stack.origin + '/preview/');
    const link = (await call(token, 'preview_link', {})).value.url + 'ukazka.html',
      anonymous = await fetch(link, { redirect: 'manual' });
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.get('location'), '/login?next=' + encodeURIComponent('/preview/ukazka.html'));
    const signedIn = await fetch(stack.origin + '/login?next=' + encodeURIComponent('/preview/ukazka.html'), {
      method: 'POST',
      headers: { Origin: stack.origin },
      body: new URLSearchParams({ password: stack.password }),
      redirect: 'manual',
    });
    assert.equal(signedIn.headers.get('location'), '/preview/ukazka.html');
    assert.match(await (await fetch(link, { headers: { Cookie: cookie } })).text(), /Text od asistenta/);
    assert.match((await call(token, 'preview_link', { commit: 'f'.repeat(40) })).error, /neexistuje/);
    assert.match((await call(token, 'read_site_file', { path: 'site/ukazka.html' })).value.text, /Ukázka asistenta/);
    // A page without a title does not pass the checks: no step, the exact reason.
    r = await call(token, 'write_site_files', {
      summary: 'Stránka bez názvu',
      files: [{ path: 'site/bez-nazvu.html', text: page.replace(/<title>.*<\/title>/, '') }],
    });
    assert.match(r.error, /Chybí název stránky: site\/bez-nazvu\.html/);
    assert.equal((await call(token, 'get_overview')).value.latest_commit, state.head);
    await settings({ enabled: 'on', edit: 'on', checks: 'key' });
    r = await call(token, 'write_site_files', {
      summary: 'Stránka bez názvu',
      files: [{ path: 'site/bez-nazvu.html', text: page.replace(/<title>.*<\/title>/, '') }],
    });
    assert.equal(r.value.checks, 'warnings');
    assert.match(r.value.warnings.join(' '), /Chybí název stránky/);
    assert.equal(r.value.step, step + 1);
    await settings({ enabled: 'on', edit: 'on' });
  },
);

test("MC-04: records go to the Content editor's unpublished edits; invalid records and a stale revision are refused", async () => {
  const { access_token: token } = await oauth('ChatGPT');
  await settings({ enabled: 'on', edit: 'on', checks: 'key' });
  const content = (await call(token, 'read_content')).value,
    pages = content.collections.pages;
  const rows = pages.rows.map((row) => ({ ...row, title: 'Nadpis od asistenta' }));
  let r = await call(token, 'write_content', { collection: 'pages', rows, revision: pages.revision });
  assert.equal(r.error, '');
  assert.notEqual(r.value.revision, pages.revision);
  const bootstrap = await (
    await fetch(stack.origin + '/content/api/bootstrap', { headers: { Cookie: cookie } })
  ).json();
  assert.equal(bootstrap.lists.pages.rows[0].title, 'Nadpis od asistenta');
  assert.equal(
    (await (await fetch(stack.origin + '/content/api/publication', { headers: { Cookie: cookie } })).json())
      .unpublished,
    true,
  );
  assert.doesNotMatch(await (await fetch(stack.website + '/')).text(), /Nadpis od asistenta/);
  // Invalid content is refused even in warn-only mode.
  r = await call(token, 'write_content', { collection: 'pages', rows: [...rows, rows[0]], revision: r.value.revision });
  assert.notEqual(r.error, '');
  r = await call(token, 'write_content', { collection: 'pages', rows, revision: pages.revision });
  assert.notEqual(r.error, '');
  await settings({ enabled: 'on', edit: 'on' });
});

test(
  'MC-05: without Edit the draft writes are refused, without Publish publishing is refused; with Publish a version is published',
  { timeout: 180000 },
  async () => {
    const { access_token: token } = await oauth('Claude');
    await settings({ enabled: 'on' });
    let r = await call(token, 'write_site_files', { summary: 'x', files: [{ path: 'site/x.html', text: page }] });
    assert.match(r.error, /nemá oprávnění Upravovat návrh/);
    r = await call(token, 'write_content', { collection: 'pages', rows: [], revision: 'x' });
    assert.match(r.error, /nemá oprávnění Upravovat návrh/);
    r = await call(token, 'publish_step', {});
    assert.match(r.error, /nemá oprávnění Publikovat/);
    await settings({ enabled: 'on', edit: 'on', publish: 'on' });
    const names = (await rpc(token, 'tools/list')).body.result.tools.map((t) => t.name);
    assert.ok(names.includes('publish_step'));
    // Publishing runs the same checks as the button: the warn-only step from MC-03 is stopped with the reason.
    r = await call(token, 'publish_step', { description: 'Od asistenta', include_unpublished_content: true });
    assert.match(r.error, /Publikování zastaveno: Chybí název stránky/);
    r = await call(token, 'write_site_files', {
      summary: 'Odebrat stránku bez názvu',
      remove: ['site/bez-nazvu.html'],
    });
    assert.equal(r.value.checks, 'passed');
    r = await call(token, 'publish_step', { description: 'Od asistenta', include_unpublished_content: true });
    assert.equal(r.error, '');
    const overview = (await call(token, 'get_overview')).value;
    assert.equal(overview.published_versions.at(-1).description, 'Od asistenta');
    assert.match(await (await fetch(stack.website + '/ukazka.html')).text(), /Text od asistenta/);
    await settings({ enabled: 'on', edit: 'on' });
  },
);

test('MC-06: no tool returns a password, key or token; writes outside the website files are refused; every call is in the action log', async () => {
  const { access_token: token } = await oauth('Claude');
  for (const path of ['site/cms/data/pages.json', '../settings/auth.json', 'settings/auth.json', 'site/../x.html'])
    assert.match(
      (await call(token, 'write_site_files', { summary: 'mimo', files: [{ path, text: '{}' }] })).error,
      /Zapisovat lze jen soubory webu|Nepovolená cesta/,
    );
  await call(token, 'get_overview');
  await call(token, 'list_site_files');
  await call(token, 'read_content');
  const secrets = [
    stack.password,
    (await readFile(join(stack.root, 'settings/gateway.token'), 'utf8')).trim(),
    (await readFile(join(stack.root, 'settings/publish.token'), 'utf8')).trim(),
    (await (await fetch(stack.origin + '/content/api/bootstrap', { headers: { Cookie: cookie } })).json()).token,
    token,
  ];
  for (const text of seen) for (const secret of secrets) assert.ok(!text.includes(secret));
  const log = JSON.parse(await readFile(join(stack.root, 'settings/mcp-log.json'), 'utf8')),
    calls = seen.filter((text) => /"result":\{"content"/.test(text)).length;
  assert.equal(log.length, Math.min(calls, 200));
  assert.ok(log.every((entry) => entry.assistant && entry.tool && entry.at));
  assert.ok(log.some((entry) => entry.assistant === 'ChatGPT' && entry.tool === 'write_content'));
  assert.ok(log.some((entry) => entry.assistant === 'Claude' && entry.tool === 'write_site_files' && !entry.ok));
  for (const secret of secrets) assert.ok(!JSON.stringify(log).includes(secret));
  const html = await (await fetch(stack.origin + '/settings/mcp', { headers: { Cookie: cookie } })).text();
  assert.match(html, /Záznam akcí MCP/);
});
