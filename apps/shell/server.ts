import { providerIds, providerName, detectProvider } from '../../packages/providers/index.mjs';
import { withSharedSettingsSave, sharedLanguage } from '../../packages/settings/shared-ui.mjs';
import { renderPage, settingsError } from './pages.ts';
import { translate } from '../../packages/i18n/index.mjs';
import {
  atomicJson,
  passwordHash,
  passwordMatches,
  readJson,
  revision,
  updateSettings,
  validateShared,
} from '../../packages/settings/index.mjs';
import { settingsReturnTo } from './settings-return.mjs';
import { servePublicPreview } from './public-preview.ts';
import { sessionCookie } from './session-cookie.mjs';
import { mailSettings, saveMailSettings, sendMail, validEmail } from '../../packages/settings/mail.mjs';
import {
  handleMcp,
  mcpMachinePaths,
  mcpSettings,
  saveMcpSettings,
  createAccessToken,
  disconnect,
  endConnections,
  mcpLog,
} from './mcp.ts';
import { appVersion } from '../aistudio/src/app-version.ts';
import { createShare, sharesFor, allShares, revokeShare, shareUrl } from './shares.ts';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
const port = Number(process.env.PORT || 4540),
  origin = process.env.EDIT_ORIGIN || 'http://127.0.0.1:' + port,
  data = process.env.SITETILLER_INSTANCE_ROOT!,
  secret = process.env.SITETILLER_GATEWAY_TOKEN!;
if (!data || !secret) throw Error('Configure gateway data and token');
// The public preview address (see public-preview.ts): the one set on Settings → Addresses and sharing, otherwise the
// installation's; none = no public preview. It is read for every request, so a change applies at once.
const installedPreviewOrigin = process.env.SITETILLER_PUBLIC_PREVIEW_ORIGIN
  ? new URL(process.env.SITETILLER_PUBLIC_PREVIEW_ORIGIN).origin
  : '';
if (installedPreviewOrigin && new URL(installedPreviewOrigin).host === new URL(origin).host)
  throw Error('The public preview needs its own address');
let publicPreviewOrigin = installedPreviewOrigin;
async function refreshPreviewOrigin() {
  let chosen = '';
  try {
    chosen = (await readJson(join(data, 'settings/shared.json'))).publicPreviewOrigin || '';
  } catch {}
  publicPreviewOrigin = chosen && new URL(chosen).host !== new URL(origin).host ? chosen : installedPreviewOrigin;
  return publicPreviewOrigin;
}
// Shared previews (documentation 4.10) live on the public preview address.
const shareContext = {
  data,
  secret,
  aiPort: Number(process.env.AISTUDIO_PORT),
  get publicOrigin() {
    return publicPreviewOrigin;
  },
};
const sessions = new Map<string, number>(),
  attempts = new Map<string, { count: number; at: number }>();
// Sessions and preview access survive a Shell restart: settings/sessions.json keeps only SHA-256 hashes of the
// tokens, so the file cannot be used to log in. Maps are keyed by those hashes; a password change clears both.
const previewAccess = new Map<string, { session: string; expires: number }>(),
  issuedPreviewKeys = new Map<string, string>(),
  sessionsFile = join(data, 'settings/sessions.json');
const hashed = (token: string) => createHash('sha256').update(token).digest('hex');
try {
  const stored = await readJson(sessionsFile);
  for (const [key, expires] of Object.entries(stored.sessions || {}))
    if (typeof expires === 'number' && expires > Date.now()) sessions.set(key, expires);
  for (const [key, value] of Object.entries(stored.previewAccess || {}) as [string, any][])
    if (value && typeof value.session === 'string' && value.expires > Date.now() && sessions.has(value.session))
      previewAccess.set(key, { session: value.session, expires: value.expires });
} catch (e: any) {
  if (e.code !== 'ENOENT') console.error('Shell sessions could not be restored (' + (e.code || e.name) + ')');
}
let sessionWrites: Promise<unknown> = Promise.resolve();
function persistSessions() {
  const now = Date.now();
  for (const [key, expires] of sessions) if (expires < now) sessions.delete(key);
  for (const [key, value] of previewAccess)
    if (value.expires < now || !sessions.has(value.session)) previewAccess.delete(key);
  const snapshot = { sessions: Object.fromEntries(sessions), previewAccess: Object.fromEntries(previewAccess) };
  sessionWrites = sessionWrites.then(() => atomicJson(sessionsFile, snapshot)).catch(() => {});
  return sessionWrites;
}
const cookieName = sessionCookie(origin);
const valid = (req: http.IncomingMessage) => {
  const token = req.headers.cookie?.match(new RegExp('(?:^|; *)' + cookieName + '=([a-f0-9]{64})'))?.[1];
  return token && (sessions.get(hashed(token)) || 0) > Date.now() ? token : null;
};
// The website name, theme and interface language of the Shell pages come from the common settings.
async function shared() {
  let settings: any = {};
  try {
    settings = await readJson(join(data, 'settings/shared.json'));
  } catch {}
  return {
    language: sharedLanguage(settings),
    theme: typeof settings.theme === 'string' ? settings.theme : 'green',
    site: typeof settings.name === 'string' && settings.name.trim() ? settings.name.trim() : 'SiteTiller',
  };
}
const settingsDirectory = join(data, 'settings'),
  resetFile = join(settingsDirectory, 'password-reset.json');
async function adminEmail() {
  try {
    const value = (await readJson(join(settingsDirectory, 'shared.json'))).adminEmail;
    return validEmail(value) ? value : '';
  } catch {
    return '';
  }
}
// The password reset (documentation 2.9) needs the administrator's e-mail and a configured mail server.
async function resetAvailable() {
  return !!(await adminEmail()) && (await mailSettings(settingsDirectory)).configured;
}
// One reset link at a time: only its SHA-256 and expiry are stored, with the send times of the last hour.
async function resetState() {
  try {
    const value = await readJson(resetFile);
    return {
      token: value.token || '',
      expires: Number(value.expires) || 0,
      sent: (value.sent || []).filter((at: number) => at > Date.now() - 3600000),
    };
  } catch {
    return { token: '', expires: 0, sent: [] as number[] };
  }
}
async function readBody(req: http.IncomingMessage) {
  let text = '';
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > 4000) throw Object.assign(Error('Too large'), { status: 413 });
  }
  return text;
}
async function readForm(req: http.IncomingMessage) {
  let text = '';
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > 4000) throw Object.assign(Error('Too large'), { status: 413 });
  }
  return new URLSearchParams(text);
}
// Signs out everywhere: a new password ends every session and preview access.
async function endSessions() {
  await endConnections(data);
  sessions.clear();
  previewAccess.clear();
  issuedPreviewKeys.clear();
  await persistSessions();
}
http
  .createServer(async (req, res) => {
    try {
      await refreshPreviewOrigin();
      if (publicPreviewOrigin && req.headers.host === new URL(publicPreviewOrigin).host)
        return await servePublicPreview(req, res, {
          origin: publicPreviewOrigin,
          data,
          previewPort: Number(process.env.PREVIEW_PORT),
        });
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(403);
        return res.end();
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const look = await shared(),
        language = look.language,
        t = (key: string, params?: Record<string, unknown>) => translate(key, language, params),
        page = async (
          status: number,
          name: string,
          props: Record<string, unknown> = {},
          override: Partial<typeof look> = {},
        ) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          // Settings screens mark E-mails in the side band until sending e-mail is set up (documentation 2.8).
          const settingsScreen = ['settings', 'mail', 'aiapi', 'mcp', 'addresses', 'password'].includes(name);
          res.end(
            await renderPage(name, settingsScreen ? { ...props, mailWarning: !(await resetAvailable()) } : props, {
              ...look,
              ...override,
            }),
          );
        };
      const url = new URL(req.url || '/', origin);
      const previewForm =
        req.method === 'POST' &&
        (url.pathname.startsWith('/preview/__sitetiller/forms/') || url.pathname.startsWith('/__sitetiller/forms/'));
      if (
        !['GET', 'HEAD'].includes(req.method || '') &&
        req.headers.origin !== origin &&
        !(previewForm && req.headers.origin === 'null') &&
        !mcpMachinePaths.includes(url.pathname)
      ) {
        res.writeHead(403);
        return res.end();
      }
      const next = url.searchParams.get('next');
      const destination =
        next && new RegExp('^/(content|site|preview)(/|$)').test(next) && !next.includes('\\') ? next : '/content/';
      const token = valid(req);
      const accessMatch = url.pathname.match(/^\/preview\/access\/([a-f0-9]{64})(\/.*)?$/),
        access = accessMatch ? previewAccess.get(hashed(accessMatch[1])) : null,
        hasPreviewAccess = !!access && access.expires > Date.now() && (sessions.get(access.session) || 0) > Date.now(),
        routePath = hasPreviewAccess ? '/preview' + (accessMatch?.[2] || '/') : url.pathname;
      const redirect = (to: string) => {
        res.writeHead(303, { Location: to });
        res.end();
      };
      // MCP server and its OAuth (documentation 2.8): 404 while switched off.
      if (
        await handleMcp(req, res, url, {
          origin,
          data,
          secret,
          aiPort: Number(process.env.AISTUDIO_PORT),
          cmsPort: Number(process.env.CMSTUDIO_PORT),
          version: appVersion,
          site: async () => look.site,
          share: (input) => createShare(shareContext, input),
          shares: async () =>
            (await allShares(shareContext)).map((s) => ({
              id: s.id,
              kind: s.kind,
              label: s.label,
              created_by: s.createdBy,
              created_at: s.createdAt,
              expires: s.expires,
              url: shareUrl(shareContext, s),
            })),
          revokeShare: (id) => revokeShare(shareContext, id),
          checkPassword: async (password, ip) => {
            const a = attempts.get(ip) || { count: 0, at: Date.now() };
            if (Date.now() - a.at > 600000) {
              a.count = 0;
              a.at = Date.now();
            }
            attempts.set(ip, a);
            if (a.count >= 8) return 'locked';
            if (passwordMatches(password, (await readJson(join(data, 'settings/auth.json'))).password)) {
              attempts.delete(ip);
              return 'ok';
            }
            a.count++;
            return 'wrong';
          },
          renderAuthorize: async (props, status) => {
            res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
            await page(status, 'mcpAuthorize', {
              ...props,
              error:
                props.error === 'locked' ? t('too_many_attempts_short') : props.error ? t('incorrect_password') : '',
            });
          },
        })
      )
        return;
      if (url.pathname === '/login' && req.method === 'POST') {
        let text = '';
        for await (const part of req) {
          text += part;
          if (text.length > 4000) {
            res.writeHead(413);
            return res.end();
          }
        }
        const ip = req.socket.remoteAddress || 'local',
          a = attempts.get(ip) || { count: 0, at: Date.now() };
        if (Date.now() - a.at > 600000) {
          a.count = 0;
          a.at = Date.now();
        }
        attempts.set(ip, a);
        if (a.count >= 8) {
          res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(t('too_many_attempts_wait'));
        }
        const params = new URLSearchParams(text),
          password = params.get('password') || '',
          config = JSON.parse(await readFile(join(data, 'settings/auth.json'), 'utf8'));
        let ok = false;
        if (config.password && password.length <= 256) {
          const expected = Buffer.from(config.password.hash, 'hex'),
            actual = Buffer.from(scryptSync(password, config.password.salt, 64).toString('hex'), 'hex');
          ok = expected.length === actual.length && timingSafeEqual(expected, actual);
        }
        if (!ok) {
          a.count++;
          return page(401, 'login', {
            action: '/login?next=' + encodeURIComponent(destination),
            error: t('incorrect_password'),
            resetAvailable: await resetAvailable(),
          });
        }
        attempts.delete(ip);
        const session = randomBytes(32).toString('hex');
        sessions.set(hashed(session), Date.now() + 8 * 3600000);
        await persistSessions();
        res.setHeader(
          'Set-Cookie',
          cookieName +
            '=' +
            session +
            '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' +
            (origin.startsWith('https:') ? '; Secure' : ''),
        );
        return redirect(destination);
      }
      if (url.pathname === '/password') {
        if (!token) return redirect('/login?next=%2Fcontent%2F');
        let error = '',
          passwordReturnTo = url.searchParams.get('returnTo');
        if (req.method === 'POST') {
          let text = '';
          for await (const part of req) {
            text += part;
            if (Buffer.byteLength(text) > 4000) {
              res.writeHead(413);
              return res.end();
            }
          }
          const params = new URLSearchParams(text);
          passwordReturnTo = params.get('returnTo');
          let result: any = {},
            ok = false;
          const current = params.get('currentPassword') || '',
            next = params.get('newPassword') || '',
            confirmed = params.get('confirmPassword') || '';
          const ip = req.socket.remoteAddress || 'local',
            prior = attempts.get(ip) || { count: 0, at: Date.now() };
          if (Date.now() - prior.at > 600000) {
            prior.count = 0;
            prior.at = Date.now();
          }
          attempts.set(ip, prior);
          if (prior.count >= 8) result.error = t('too_many_attempts_short');
          else if (next.length < 8 || next.length > 256 || next !== confirmed)
            result.error = t('new_password_requirements');
          else {
            const state = await fetch('http://127.0.0.1:' + process.env.AISTUDIO_PORT + '/api/state', {
              headers: { 'x-sitetiller-gateway': secret },
              signal: AbortSignal.timeout(10000),
            });
            if (!state.ok || (await state.json()).busy) result.error = t('wait_for_task_to_finish');
            else {
              const config = await readJson(join(data, 'settings/auth.json'));
              if (!passwordMatches(current, config.password)) {
                prior.count++;
                result.error = t('current_password_incorrect');
              } else {
                await updateSettings(
                  join(data, 'settings/auth.json'),
                  { password: passwordHash(next) },
                  revision(config),
                );
                attempts.delete(ip);
                ok = true;
              }
            }
          }
          if (ok) {
            await endConnections(data);
            sessions.clear();
            previewAccess.clear();
            issuedPreviewKeys.clear();
            await persistSessions();
            res.setHeader(
              'Set-Cookie',
              cookieName +
                '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' +
                (origin.startsWith('https:') ? '; Secure' : ''),
            );
            return page(200, 'passwordChanged');
          }
          error = typeof result.error === 'string' ? result.error : t('password_change_failed');
        }
        return page(200, 'password', { error, returnTo: settingsReturnTo(passwordReturnTo) });
      }
      if (url.pathname === '/logout') {
        if (token) {
          sessions.delete(hashed(token));
          issuedPreviewKeys.delete(hashed(token));
          await persistSessions();
        }
        res.setHeader('Set-Cookie', cookieName + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return redirect('/login');
      }
      // Forgot password (documentation 2.9): one button, the link goes to the administrator's e-mail.
      if (url.pathname === '/forgot') {
        const available = await resetAvailable();
        if (req.method !== 'POST') return page(200, 'forgot', { available, error: '', notice: '' });
        await readForm(req);
        if (!available) return page(200, 'forgot', { available, error: '', notice: '' });
        const state = await resetState();
        if (state.sent.length >= 3) return page(429, 'forgot', { available, error: t('reset_link_limit'), notice: '' });
        const secretToken = randomBytes(32).toString('hex'),
          link = origin + '/reset/' + secretToken;
        try {
          await sendMail(settingsDirectory, {
            to: await adminEmail(),
            subject: translate('reset_email_subject', language, { site: look.site }),
            text: translate('reset_email_body', language, { link }),
          });
        } catch (e: any) {
          console.error('Password reset e-mail not sent: ' + (e.code || e.name));
          return page(502, 'forgot', { available, error: t('reset_link_failed'), notice: '' });
        }
        await atomicJson(resetFile, {
          token: hashed(secretToken),
          expires: Date.now() + 1800000,
          sent: [...state.sent, Date.now()],
        });
        return page(200, 'forgot', { available, error: '', notice: t('reset_link_sent') });
      }
      const resetMatch = url.pathname.match(/^\/reset\/([a-f0-9]{64})$/);
      if (resetMatch) {
        const state = await resetState(),
          action = '/reset/' + resetMatch[1],
          valid = !!state.token && state.token === hashed(resetMatch[1]) && state.expires > Date.now();
        if (!valid) return page(410, 'reset', { valid: false, action, error: '' });
        if (req.method !== 'POST') return page(200, 'reset', { valid, action, error: '' });
        const params = await readForm(req),
          next = params.get('newPassword') || '';
        if (next.length < 8 || next.length > 256 || next !== (params.get('confirmPassword') || ''))
          return page(422, 'reset', { valid, action, error: t('new_password_requirements') });
        const config = await readJson(join(settingsDirectory, 'auth.json'));
        await updateSettings(
          join(settingsDirectory, 'auth.json'),
          { ...config, password: passwordHash(next) },
          revision(config),
        );
        await atomicJson(resetFile, { token: '', expires: 0, sent: state.sent });
        await endSessions();
        // The new password signs the user in at once.
        const session = randomBytes(32).toString('hex');
        sessions.set(hashed(session), Date.now() + 8 * 3600000);
        await persistSessions();
        res.setHeader(
          'Set-Cookie',
          cookieName +
            '=' +
            session +
            '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' +
            (origin.startsWith('https:') ? '; Secure' : ''),
        );
        return redirect('/content/');
      }
      // A saved draft's preview is sandboxed, so the browser sends no sign-in cookie with the files the page loads
      // (styles, scripts, images). Those files come with the draft's own short-lived key, which the preview checks;
      // the page itself still needs the sign-in (documentation 2.8).
      const draftAccess = url.pathname.match(
          /^\/preview\/drafts\/draft-[a-f0-9]{32}\/access\/([0-9]{13})-[a-f0-9]{64}\/./,
        ),
        draftAsset =
          !!draftAccess &&
          ['GET', 'HEAD'].includes(req.method || '') &&
          Number(draftAccess[1]) > Date.now() &&
          ['style', 'script', 'image', 'font', 'audio', 'video', 'track', 'manifest'].includes(
            String(req.headers['sec-fetch-dest'] || ''),
          );
      if (!token && !previewForm && !hasPreviewAccess && !draftAsset) {
        if (url.pathname !== '/login') return redirect('/login?next=' + encodeURIComponent(url.pathname + url.search));
        return page(200, 'login', {
          action: '/login?next=' + encodeURIComponent(destination),
          error: '',
          resetAvailable: await resetAvailable(),
        });
      }
      if (url.pathname === '/login') return redirect('/');
      if (url.pathname === '/') return page(200, 'home');

      if (url.pathname === '/settings') {
        const path = join(data, 'settings/shared.json');
        let current = await readJson(path),
          error = '',
          notice = '',
          returnTo = settingsReturnTo(url.searchParams.get('returnTo')),
          entered: any = null;
        if (req.method === 'POST') {
          let body = '';
          for await (const part of req) {
            body += part;
            if (Buffer.byteLength(body) > 4000) {
              res.writeHead(413);
              return res.end();
            }
          }
          const input = new URLSearchParams(body);
          entered = Object.fromEntries(
            [...input].filter(([key]) => ['name', 'theme', 'language', 'contentDefault'].includes(key)),
          );
          returnTo = settingsReturnTo(input.get('returnTo'));
          try {
            await withSharedSettingsSave(path, async () => {
              current = await readJson(path);
              const candidate = validateShared(
                {
                  name: input.get('name'),
                  theme: input.get('theme'),
                  ...(input.has('language') ? { language: input.get('language') } : {}),
                  ...(input.has('contentDefault') ? { contentDefault: input.get('contentDefault') } : {}),
                },
                { current },
              );
              if (input.get('revision') !== revision(current))
                throw Object.assign(Error('Nastavení se mezitím změnilo.'), { status: 409 });
              await updateSettings(path, candidate, input.get('revision'));
            });
            // Save only saves; Back leaves the settings.
            current = await readJson(path);
            entered = null;
            notice = t('saved');
          } catch (e: any) {
            error = e.message;
            res.statusCode = e.status || 500;
            current = await readJson(path);
          }
        }
        // A rejected save shows the entered values again, in the language the user chose.
        const shown = ['cs', 'en'].includes(entered?.language) ? entered.language : sharedLanguage(current),
          fields = {
            ...current,
            ...entered,
            language: entered?.language ?? current.language ?? shown,
            contentDefault: entered?.contentDefault ?? current.contentDefault ?? 'draft',
          };
        return page(
          res.statusCode || 200,
          'settings',
          {
            fields,
            error: error ? settingsError(error, shown) : '',
            notice: notice ? translate('saved', shown) : '',
            returnTo,
            revision: revision(current),
          },
          { language: shown },
        );
      }

      // Sending e-mail with the administrator's e-mail (documentation 2.8): everything about mail on one screen.
      if (url.pathname === '/settings/mail') {
        let error = '',
          notice = '',
          mail = await mailSettings(settingsDirectory),
          shownAdmin = await adminEmail(),
          mailReturnTo = url.searchParams.get('returnTo');
        if (req.method === 'POST') {
          const input = await readForm(req);
          mailReturnTo = input.get('returnTo');
          shownAdmin = (input.get('adminEmail') || '').trim();
          try {
            const sharedPath = join(settingsDirectory, 'shared.json');
            await withSharedSettingsSave(sharedPath, async () => {
              const current = await readJson(sharedPath),
                candidate = validateShared(
                  { name: current.name, theme: current.theme, adminEmail: shownAdmin },
                  { current },
                );
              await updateSettings(sharedPath, candidate, revision(current));
            });
            mail = await saveMailSettings(settingsDirectory, Object.fromEntries(input));
            notice = t('mail_settings_saved');
            if (input.get('action') === 'test') {
              const to = await adminEmail();
              if (!to) throw Object.assign(Error(t('test_email_needs_admin')), { test: true });
              try {
                await sendMail(settingsDirectory, {
                  to,
                  subject: translate('test_email_subject', language, { site: look.site }),
                  text: translate('test_email_body', language, { site: look.site }),
                });
                notice = translate('test_email_sent', language, { email: to });
              } catch (e: any) {
                throw Object.assign(Error(translate('test_email_failed', language, { detail: e.message })), {
                  test: true,
                });
              }
            }
          } catch (e: any) {
            error = e.test ? e.message : settingsError(e.message, language);
            notice = '';
            res.statusCode = e.test ? 200 : e.status || 500;
          }
        }
        return page(res.statusCode || 200, 'mail', {
          mail,
          adminEmail: shownAdmin,
          error,
          notice,
          returnTo: settingsReturnTo(mailReturnTo),
        });
      }

      // The Share dialog of the AI Studio (documentation 4.10): the links to one state, a new link, revoking one.
      if (url.pathname === '/__shell/shares' || url.pathname === '/__shell/shares/revoke') {
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(value));
        };
        try {
          if (req.method === 'GET' && url.pathname === '/__shell/shares') {
            const source = Object.fromEntries(url.searchParams) as any,
              shares = await sharesFor(shareContext, source);
            return reply(200, {
              shares: shares.map((share) => ({
                id: share.id,
                url: shareUrl(shareContext, share),
                createdBy: share.createdBy,
                createdAt: share.createdAt,
                expires: share.expires,
              })),
            });
          }
          if (req.method !== 'POST') return reply(405, { error: 'Nepovolená metoda.' });
          const input = JSON.parse(await readBody(req));
          if (url.pathname === '/__shell/shares/revoke')
            return reply(200, { revoked: await revokeShare(shareContext, String(input.id || '')) });
          return reply(200, await createShare(shareContext, { ...input, createdBy: t('share_by_user') }));
        } catch (e: any) {
          return reply(e.status || 400, { error: e.message });
        }
      }
      // Addresses and sharing (documentation 2.4): the instance addresses read only, the public preview switch and
      // every shared link (copy again, revoke one, revoke all after asking).
      if (url.pathname === '/settings/addresses') {
        const sharedPath = join(settingsDirectory, 'shared.json');
        let confirmAll = false,
          error = '',
          notice = '',
          back = url.searchParams.get('returnTo');
        if (req.method === 'POST') {
          const input = await readForm(req);
          back = input.get('returnTo');
          try {
            if (input.get('action') === 'preview') {
              const address = (input.get('previewOrigin') || '').trim();
              if (address) {
                let host = '';
                try {
                  host = new URL(address).host;
                } catch {}
                if (host === new URL(origin).host)
                  throw Object.assign(Error(t('preview_address_not_editor')), { status: 422 });
              }
              if (input.has('publicPreview') && !address && !installedPreviewOrigin)
                throw Object.assign(Error(t('preview_address_required')), { status: 422 });
              await withSharedSettingsSave(sharedPath, async () => {
                const current = await readJson(sharedPath);
                if (input.get('revision') !== revision(current))
                  throw Object.assign(Error('Nastavení se mezitím změnilo.'), { status: 409 });
                await updateSettings(
                  sharedPath,
                  validateShared(
                    {
                      name: current.name,
                      theme: current.theme,
                      publicPreview: input.has('publicPreview'),
                      publicPreviewOrigin: address,
                    },
                    { current },
                  ),
                  revision(current),
                );
              });
              notice = t('saved');
            } else if (input.get('action') === 'revokeAll' && input.get('confirm') !== 'yes') confirmAll = true;
            else {
              await revokeShare(shareContext, input.get('action') === 'revokeAll' ? null : input.get('id') || '');
              notice = t('share_revoked');
            }
          } catch (e: any) {
            error = settingsError(e.message, language);
            res.statusCode = e.status || 500;
          }
        }
        let shares: any[] = [];
        try {
          shares = publicPreviewOrigin ? await allShares(shareContext) : [];
        } catch (e: any) {
          error = error || e.message;
        }
        const current = await readJson(sharedPath);
        await refreshPreviewOrigin();
        return page(res.statusCode || 200, 'addresses', {
          error,
          notice,
          confirmAll,
          revision: revision(current),
          publicPreview: current.publicPreview === true,
          previewAvailable: true,
          previewOrigin: current.publicPreviewOrigin || '',
          installedPreviewOrigin,
          // They come from instance.json at start.
          addresses: [
            { label: 'address_editor', value: origin, help: 'address_editor_help' },
            { label: 'address_preview', value: publicPreviewOrigin, help: 'address_preview_help' },
            {
              label: 'address_website',
              value: process.env.SITETILLER_SITE_URL || '',
              help: process.env.SITETILLER_WEBSITE_GIT
                ? 'address_website_external_help'
                : 'address_website_internal_help',
            },
            ...(process.env.SITETILLER_WEBSITE_GIT
              ? [
                  {
                    label: 'address_website_git',
                    value: process.env.SITETILLER_WEBSITE_GIT,
                    help: 'address_website_git_help',
                  },
                ]
              : []),
          ],
          shares: shares
            .slice()
            .reverse()
            .map((share) => ({
              id: share.id,
              label: share.label,
              url: shareUrl(shareContext, share),
              createdBy: share.createdBy,
              createdAt: share.createdAt,
              expires: share.expires,
            })),
          returnTo: settingsReturnTo(back),
        });
      }
      // MCP (documentation 2.4, 2.8): access, permissions, checks and the connected assistants.
      if (url.pathname === '/settings/mcp') {
        let error = '',
          notice = '',
          token = '',
          back = url.searchParams.get('returnTo');
        if (req.method === 'POST') {
          const input = await readForm(req);
          back = input.get('returnTo');
          try {
            const action = input.get('action');
            if (action === 'token') {
              token = await createAccessToken(data, input.get('tokenName') || '');
              notice = t('mcp_token_created');
            } else if (action === 'disconnect') {
              await disconnect(data, input.get('id') || '');
              notice = t('mcp_disconnected');
            } else {
              await saveMcpSettings(data, {
                enabled: input.has('enabled'),
                edit: input.has('edit'),
                delete: input.has('delete'),
                publish: input.has('publish'),
                checks: (['strict', 'key', 'none'] as const).find((v) => v === input.get('checks')) || 'strict',
              });
              notice = t('saved');
            }
          } catch (e: any) {
            error = e.message;
            res.statusCode = 422;
          }
        }
        const settings = await mcpSettings(data);
        return page(res.statusCode || 200, 'mcp', {
          error,
          notice,
          token,
          settings: {
            enabled: settings.enabled,
            edit: settings.edit,
            delete: settings.delete,
            publish: settings.publish,
            checks: settings.checks,
          },
          connections: settings.connections.map(({ id, name, kind, createdAt, lastUsed }) => ({
            id,
            name,
            kind,
            createdAt,
            lastUsed,
          })),
          log: (await mcpLog(data)).slice().reverse(),
          address: origin + '/mcp',
          returnTo: settingsReturnTo(back),
        });
      }

      // AI models (documentation 2.10): the AI Studio's keys, team models and image tools, edited here.
      if (url.pathname === '/settings/aiapi' || url.pathname === '/settings/aiapi/catalog') {
        let error = '',
          keyError = '',
          confirmKey = '',
          notice = '',
          back = url.searchParams.get('returnTo');
        const ai = async (path: string, value?: unknown) => {
          const response = await fetch('http://127.0.0.1:' + process.env.AISTUDIO_PORT + '/api/' + path, {
            method: value === undefined ? 'GET' : 'POST',
            headers: {
              'x-sitetiller-gateway': secret,
              origin: 'http://127.0.0.1:' + process.env.AISTUDIO_PORT,
              'content-type': 'application/json',
            },
            ...(value === undefined ? {} : { body: JSON.stringify(value) }),
            signal: AbortSignal.timeout(60000),
          });
          const result: any = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(result.error || t('studio_starting'));
          return result;
        };
        // The team roles and image tools with their options: from the catalog, or only the saved choice before it.
        const modelView = (state: any, catalog: any, entered: any) => {
          const provider = (id: string) => providerName(id),
            usable = (catalog?.models || []).filter((m: any) => m.usable),
            // Without the catalog yet, the saved choice is the only option and is not marked as unconfirmed.
            withSaved = (options: any[], value: string, label: string) =>
              value && value !== 'none' && !options.some((o) => o.value === value)
                ? [...options, { value, label: label + (catalog ? t('availability_unconfirmed') : '') }]
                : options,
            chosen = entered?.roles || state.roles || {},
            imageChoice = entered?.imageModels || state.imageModels || {};
          const roleLabels: Record<string, string> = {
            primary: t('web_lead_primary_agent'),
            ui: t('ui_code_specialist_larger_implementations'),
            verify: t('verifier_independent_verification'),
            escalation: t('escalation_repeated_failure'),
          };
          const roles = Object.entries(roleLabels).map(([id, label]) => {
            const choice = chosen[id] || {},
              value = choice.provider ? choice.provider + '|' + choice.model : '';
            return {
              id,
              label,
              value,
              effort: choice.reasoningEffort || (id === 'escalation' ? 'high' : 'auto'),
              options: withSaved(
                usable.map((m: any) => ({
                  value: m.provider + '|' + m.id,
                  label: provider(m.provider) + ' · ' + m.name,
                })),
                value,
                choice.provider ? provider(choice.provider) + ' · ' + choice.model : '',
              ),
            };
          });
          const imageOptions = (catalog?.models || [])
            .filter(
              (m: any) =>
                (m.provider === 'openai' && /^gpt-image-/.test(m.id)) ||
                (m.provider === 'gemini' && /^gemini-[a-zA-Z0-9.-]*image/.test(m.id)),
            )
            .map((m: any) => ({ value: m.id, label: provider(m.provider) + ' · ' + m.name }));
          const images = [
            ['precise', t('images_precise_editing')],
            ['fast', t('images_fast_generation')],
          ].map(([id, label]) => ({
            id,
            label,
            value: imageChoice[id] || 'none',
            options: withSaved(imageOptions, imageChoice[id], imageChoice[id]),
          }));
          return {
            roles,
            images,
            alerts: catalog ? [...(catalog.issues || []), ...(catalog.optionalIssues || [])] : [],
            // A saved key that does not work, even when no team model uses it.
            keyErrors: Object.fromEntries(
              (catalog?.providers || [])
                .filter((p: any) => p.error && p.errorKind !== 'missing_key')
                .map((p: any) => [p.provider, { name: providerName(p.provider), reason: p.detail }]),
            ),
          };
        };
        if (url.pathname === '/settings/aiapi/catalog') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          try {
            // The models first: with Team automatically by the recommendation they may change the team.
            const models = await ai('models', { keys: {} }),
              view = modelView(await ai('state'), models, null);
            return res.end(JSON.stringify(view));
          } catch (e: any) {
            res.statusCode = 502;
            return res.end(JSON.stringify({ error: e.message }));
          }
        }
        let entered: any = null;
        if (req.method === 'POST') {
          const input = await readForm(req);
          back = input.get('returnTo');
          // Remove a key: the first press asks, the second removes (documentation 2.4).
          const removal = (input.get('action') || '').match(/^remove_([a-z]+)(_yes)?$/);
          if (removal && !providerIds.includes(removal[1]))
            throw Object.assign(Error('Neznámý poskytovatel.'), { status: 422 });
          // Add a key: one field for every provider, told by the key's shape; the same provider's key is replaced
          // only after the confirm dialog (documentation 2.4).
          if (input.get('action') === 'addKey') {
            const value = (input.get('key') || '').trim(),
              detected = detectProvider(value),
              current = await ai('state').catch(() => ({}) as any);
            if (!value) keyError = t('key_enter');
            else if (detected.problem === 'admin') keyError = t('key_admin');
            else if (!detected.provider) keyError = t('key_unknown');
            else if (
              (current.providers || []).some((p: any) => p.provider === detected.provider && p.hasKey) &&
              input.get('confirm') !== 'yes'
            )
              keyError = t('key_replace_confirm', { provider: providerName(detected.provider) });
            else
              try {
                await ai('keys/add', { provider: detected.provider, key: value });
                notice = t('key_added', { provider: providerName(detected.provider) });
              } catch (e: any) {
                keyError = e.message;
              }
            if (keyError) res.statusCode = 422;
          } else if (removal && !removal[2] && input.get('confirm') !== 'yes') confirmKey = removal[1];
          else if (removal)
            try {
              await ai('keys/remove', { provider: removal[1] });
              notice = t('key_removed');
            } catch (e: any) {
              error = e.message;
              res.statusCode = 422;
            }
          else {
            const roles = Object.fromEntries(
              ['primary', 'ui', 'verify', 'escalation'].map((role) => {
                const value = input.get('role_' + role) || '',
                  separator = value.indexOf('|');
                return [
                  role,
                  {
                    provider: value.slice(0, separator),
                    model: value.slice(separator + 1),
                    reasoningEffort: input.get('effort_' + role) || 'auto',
                  },
                ];
              }),
            );
            entered = {
              roles,
              imageModels: { precise: input.get('image_precise') || 'none', fast: input.get('image_fast') || 'none' },
            };
            try {
              // Team automatically by the recommendation: the team comes from the recommendation (documentation 4.6).
              const autoTeam = input.has('autoTeam');
              await ai('settings', {
                ...entered,
                autoTeam,
                ...(autoTeam
                  ? await ai('state').then((state: any) => ({ roles: state.roles, imageModels: state.imageModels }))
                  : {}),
              });
              entered = null;
              notice = t('saved');
            } catch (e: any) {
              error = e.message;
              res.statusCode = 422;
            }
          }
        }
        let state: any = {};
        try {
          state = await ai('state');
        } catch (e: any) {
          error = error || e.message;
        }
        const { roles, images } = modelView(state, null, entered);
        const keys = (state.providers || [])
          .filter((p: any) => p.hasKey)
          .map((p: any) => ({ id: p.provider, name: providerName(p.provider) }));
        return page(res.statusCode || 200, 'aiapi', {
          error,
          notice,
          alerts: [],
          networkMode: state.networkMode,
          keys,
          keyError,
          confirmKey,
          autoTeam: !!state.autoTeam,
          recommendation: state.recommendation || { date: '', source: 'bundled' },
          roles,
          images,
          returnTo: settingsReturnTo(back),
        });
      }

      // Studios stay alive: a top-level visit of a studio screen gets the frame page, which loads the studio into an
      // iframe (Sec-Fetch-Dest: iframe) proxied below. Browsers without the header get the studio directly.
      if (
        req.method === 'GET' &&
        req.headers['sec-fetch-dest'] === 'document' &&
        /^\/(content\/(structure)?|site\/)$/.test(url.pathname)
      ) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<!doctype html><html lang="' +
            language +
            '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteTiller</title><style>html,body{margin:0;height:100%;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block}iframe[hidden]{display:none}</style></head><body><script src="/__shell/frame.js"></script></body></html>',
        );
      }
      // The interface library's confirm dialog for the settings pages (documentation 0.5).
      if (req.method === 'GET' && url.pathname === '/__shell/ui/confirm-dialog.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(new URL('../../packages/ui/confirm-dialog.js', import.meta.url), 'utf8'));
      }
      // The providers' list and the key shapes, for the Add key confirm on the AI models page.
      if (req.method === 'GET' && url.pathname === '/__shell/providers.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(new URL('../../packages/providers/index.mjs', import.meta.url), 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/__shell/frame.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(new URL('./frame.js', import.meta.url), 'utf8'));
      }
      const match = (
        previewForm && url.pathname.startsWith('/__sitetiller/forms/') ? '/preview' + url.pathname : routePath
      ).match(/^\/(content|site|preview)(\/.*)?$/);
      if (!match) {
        res.writeHead(404);
        return res.end();
      }
      if (!match[2]) return redirect(url.pathname + '/');
      const prefix = '/' + match[1] + (hasPreviewAccess ? '/access/' + accessMatch![1] : ''),
        upstream = Number(
          match[1] === 'content'
            ? process.env.CMSTUDIO_PORT
            : match[1] === 'site'
              ? process.env.AISTUDIO_PORT
              : process.env.PREVIEW_PORT,
        ),
        headers = {
          ...req.headers,
          host: '127.0.0.1:' + upstream,
          origin: 'http://127.0.0.1:' + upstream,
          'x-sitetiller-gateway': secret,
        };
      delete headers['content-length'];
      const proxy = http.request(
        { hostname: '127.0.0.1', port: upstream, path: match[2] + url.search, method: req.method, headers },
        (response) => {
          const out = { ...response.headers };
          delete out['set-cookie'];
          if (out.location?.startsWith('/')) out.location = prefix + out.location;
          if (
            token &&
            match[1] === 'site' &&
            match[2] === '/api/state' &&
            (out['content-type'] || '').includes('application/json')
          ) {
            const chunks: Buffer[] = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => {
              try {
                const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const session = hashed(token);
                let key = issuedPreviewKeys.get(session);
                if (!key || !previewAccess.has(hashed(key))) {
                  key = randomBytes(32).toString('hex');
                  issuedPreviewKeys.set(session, key);
                  previewAccess.set(hashed(key), { session, expires: sessions.get(session)! });
                  persistSessions();
                }
                state.previewUrl = origin + '/preview/access/' + key + '/';
                delete out['content-length'];
                res.writeHead(response.statusCode || 502, out);
                res.end(JSON.stringify(state));
              } catch {
                res.writeHead(502);
                res.end();
              }
            });
          } else if (match[1] === 'preview' && (out['content-type'] || '').includes('text/html')) {
            const chunks: Buffer[] = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', async () => {
              let body = Buffer.concat(chunks).toString('utf8'); // Studio pages are served as they are; only the user's website preview gets its access prefix.
              if (match[1] === 'preview')
                body = body.replace(/((?:src|href|action)=["'])\/(?!\/)/g, '$1' + prefix + '/');
              delete out['content-length'];
              res.writeHead(response.statusCode || 502, out);
              res.end(body);
            });
          } else {
            res.writeHead(response.statusCode || 502, out);
            response.pipe(res);
          }
        },
      );
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end(t('studio_starting'));
      });
      req.pipe(proxy);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end(translate('administration_unavailable', 'cs'));
    }
  })
  .listen(port, process.env.EDIT_HOST || '127.0.0.1');
// With its own port the public preview answers there on any host name; the studios are never reachable on it.
if (process.env.SITETILLER_PUBLIC_PREVIEW_PORT)
  http
    .createServer(async (req, res) => {
      try {
        if (!(await refreshPreviewOrigin())) {
          res.writeHead(404);
          return res.end();
        }
        await servePublicPreview(req, res, {
          origin: publicPreviewOrigin,
          data,
          previewPort: Number(process.env.PREVIEW_PORT),
        });
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })
    .listen(Number(process.env.SITETILLER_PUBLIC_PREVIEW_PORT), process.env.EDIT_HOST || '127.0.0.1');
