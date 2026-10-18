import { withSharedSettingsSave, sharedLanguage } from '../../packages/settings/shared-ui.mjs';
import { renderPage, settingsError } from './pages.ts';
import { translate } from '../../packages/i18n/index.mjs';
import { settingsSiteUrl } from '../aistudio/src/settings-site-url.ts';
import {
  atomicJson,
  passwordHash,
  passwordMatches,
  readJson,
  revision,
  updateSettings,
  validateShared,
  migrateSharedSiteUrl,
} from '../../packages/settings/index.mjs';
import { settingsReturnTo } from './settings-return.mjs';
import { servePublicPreview } from './public-preview.ts';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
const port = Number(process.env.PORT || 4540),
  origin = process.env.EDIT_ORIGIN || 'http://127.0.0.1:' + port,
  data = process.env.SITETILLER_INSTANCE_ROOT!,
  secret = process.env.SITETILLER_GATEWAY_TOKEN!;
if (!data || !secret) throw Error('Configure gateway data and token');
// The instance's public draft preview address (see public-preview.ts); none = no public preview.
const publicPreviewOrigin = process.env.SITETILLER_PUBLIC_PREVIEW_ORIGIN
  ? new URL(process.env.SITETILLER_PUBLIC_PREVIEW_ORIGIN).origin
  : '';
if (publicPreviewOrigin && new URL(publicPreviewOrigin).host === new URL(origin).host)
  throw Error('The public preview needs its own address');
const sessions = new Map<string, number>(),
  attempts = new Map<string, { count: number; at: number }>();
await migrateSharedSiteUrl(
  join(data, 'settings/shared.json'),
  join(data, '.sitetiller/config.json'),
  settingsSiteUrl,
  process.env.SITETILLER_SITE_URL || '',
);
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
const valid = (req: http.IncomingMessage) => {
  const token = req.headers.cookie?.match(/(?:^|; *)sitetiller_edit=([a-f0-9]{64})/)?.[1];
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
http
  .createServer(async (req, res) => {
    try {
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
        t = (key: string) => translate(key, language),
        page = async (
          status: number,
          name: string,
          props: Record<string, unknown> = {},
          override: Partial<typeof look> = {},
        ) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(await renderPage(name, props, { ...look, ...override }));
        };
      const url = new URL(req.url || '/', origin);
      const previewForm =
        req.method === 'POST' &&
        (url.pathname.startsWith('/preview/__sitetiller/forms/') || url.pathname.startsWith('/__sitetiller/forms/'));
      if (
        !['GET', 'HEAD'].includes(req.method || '') &&
        req.headers.origin !== origin &&
        !(previewForm && req.headers.origin === 'null')
      ) {
        res.writeHead(403);
        return res.end();
      }
      const next = url.searchParams.get('next');
      const destination =
        next && new RegExp('^/(content|site)(/|$)').test(next) && !next.includes('\\') ? next : '/content/';
      const token = valid(req);
      const accessMatch = url.pathname.match(/^\/preview\/access\/([a-f0-9]{64})(\/.*)?$/),
        access = accessMatch ? previewAccess.get(hashed(accessMatch[1])) : null,
        hasPreviewAccess = !!access && access.expires > Date.now() && (sessions.get(access.session) || 0) > Date.now(),
        routePath = hasPreviewAccess ? '/preview' + (accessMatch?.[2] || '/') : url.pathname;
      const redirect = (to: string) => {
        res.writeHead(303, { Location: to });
        res.end();
      };
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
          });
        }
        attempts.delete(ip);
        const session = randomBytes(32).toString('hex');
        sessions.set(hashed(session), Date.now() + 8 * 3600000);
        await persistSessions();
        res.setHeader(
          'Set-Cookie',
          'sitetiller_edit=' +
            session +
            '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' +
            (origin.startsWith('https:') ? '; Secure' : ''),
        );
        return redirect(destination);
      }
      if (url.pathname === '/password') {
        if (!token) return redirect('/login?next=%2Fcontent%2F');
        let error = '';
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
            sessions.clear();
            previewAccess.clear();
            issuedPreviewKeys.clear();
            await persistSessions();
            res.setHeader(
              'Set-Cookie',
              'sitetiller_edit=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' +
                (origin.startsWith('https:') ? '; Secure' : ''),
            );
            return page(200, 'passwordChanged');
          }
          error = typeof result.error === 'string' ? result.error : t('password_change_failed');
        }
        return page(200, 'password', { error });
      }
      if (url.pathname === '/logout') {
        if (token) {
          sessions.delete(hashed(token));
          issuedPreviewKeys.delete(hashed(token));
          await persistSessions();
        }
        res.setHeader('Set-Cookie', 'sitetiller_edit=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return redirect('/login');
      }
      if (!token && !previewForm && !hasPreviewAccess) {
        if (url.pathname !== '/login') return redirect('/login?next=' + encodeURIComponent(url.pathname + url.search));
        return page(200, 'login', { action: '/login?next=' + encodeURIComponent(destination), error: '' });
      }
      if (url.pathname === '/login') return redirect('/');
      if (url.pathname === '/') return page(200, 'home');

      if (url.pathname === '/settings') {
        const path = join(data, 'settings/shared.json');
        let current = await readJson(path),
          error = '',
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
            [...input].filter(([key]) => ['name', 'theme', 'language', 'siteUrl', 'contentDefault'].includes(key)),
          );
          // An unchecked box sends nothing; the form marks that it offered the switch.
          if (publicPreviewOrigin && input.has('publicPreviewOffered'))
            entered.publicPreview = input.has('publicPreview');
          returnTo = settingsReturnTo(input.get('returnTo'));
          try {
            await withSharedSettingsSave(path, async () => {
              current = await readJson(path);
              const candidate = validateShared(
                {
                  name: input.get('name'),
                  theme: input.get('theme'),
                  ...(input.has('language') ? { language: input.get('language') } : {}),
                  ...(input.has('siteUrl') ? { siteUrl: input.get('siteUrl') } : {}),
                  ...(input.has('contentDefault') ? { contentDefault: input.get('contentDefault') } : {}),
                  ...(Object.hasOwn(entered, 'publicPreview') ? { publicPreview: entered.publicPreview } : {}),
                },
                { current, validateSiteUrl: settingsSiteUrl },
              );
              if (input.get('revision') !== revision(current))
                throw Object.assign(Error('Nastavení se mezitím změnilo.'), { status: 409 });
              await updateSettings(path, candidate, input.get('revision'));
            });
            return redirect(returnTo);
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
            publicPreview: entered?.publicPreview ?? current.publicPreview === true,
          };
        return page(
          res.statusCode || 200,
          'settings',
          {
            fields,
            error: error ? settingsError(error, shown) : '',
            returnTo,
            revision: revision(current),
            publicPreviewUrl: publicPreviewOrigin ? publicPreviewOrigin + '/' : '',
          },
          { language: shown },
        );
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
if (publicPreviewOrigin && process.env.SITETILLER_PUBLIC_PREVIEW_PORT)
  http
    .createServer(async (req, res) => {
      try {
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
