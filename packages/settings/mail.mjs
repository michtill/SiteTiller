// Sending e-mail (documentation 2.8): one service of the instance for the password reset and for the forms of the
// website running in the instance: the instance's own SMTP server (the default) or Brevo or Resend over HTTPS.
// settings/mail.json keeps the service, server, port, user and sender; the server password and the API keys are
// encrypted with settings/mail.key (600) and never shown again. Nothing comes from environment variables.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { atomicJson, readJson, validEmail } from './index.mjs';
import { mailApis } from './mail-apis.mjs';
export { validEmail };
export const mailServices = ['smtp', ...Object.keys(mailApis)];
const localHosts = ['127.0.0.1', 'localhost', '::1'];
const fail = (message) => Object.assign(Error(message), { status: 422 });
async function mailKey(settings) {
  const path = join(settings, 'mail.key');
  try {
    return await readFile(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const key = randomBytes(32);
    await writeFile(path, key, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return readFile(path);
  }
}
function seal(text, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv),
    data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
}
function open(value, key) {
  const [iv, tag, data] = String(value).split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
async function stored(settings) {
  try {
    return await readJson(join(settings, 'mail.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}
// What the settings screen shows: never the password, only whether one is set.
export async function mailSettings(settings) {
  const value = await stored(settings),
    service = mailServices.includes(value.service) ? value.service : 'smtp',
    keySet = Object.fromEntries(Object.keys(mailApis).map((id) => [id, !!value.keys?.[id]]));
  return {
    service,
    host: value.host || '',
    port: value.port || 587,
    user: value.user || '',
    from: value.from || '',
    passwordSet: !!value.password,
    keySet,
    configured: !!((service === 'smtp' ? value.host : keySet[service]) && value.from),
  };
}
// Saves the screen's values; an empty password or key keeps the stored one, and switching the service keeps the other
// service's password and key.
export async function saveMailSettings(settings, input) {
  const service = input.service === undefined || input.service === '' ? 'smtp' : String(input.service);
  if (!mailServices.includes(service)) throw fail('Zvolte službu pro odesílání.');
  const host = String(input.host || '').trim(),
    port = Number(input.port),
    user = String(input.user || '').trim(),
    from = String(input.from || '').trim(),
    password = typeof input.password === 'string' ? input.password : '';
  if (host && !/^[A-Za-z0-9.-]{1,253}$|^::1$/.test(host)) throw fail('Zadejte platný název poštovního serveru.');
  // A relay on this computer (development, tests) may use any port; a real server 465 or 587.
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (![465, 587].includes(port) && !localHosts.includes(host)))
    throw fail('Port musí být 465 nebo 587.');
  if (user.length > 256 || password.length > 256) throw fail('Uživatel nebo heslo je příliš dlouhé.');
  if (from && !validEmail(from)) throw fail('Zadejte platnou adresu odesílatele.');
  const current = await stored(settings),
    keys = { ...(current.keys || {}) };
  for (const id of Object.keys(mailApis)) {
    const key = typeof input[id + 'Key'] === 'string' ? input[id + 'Key'].trim() : '';
    if (!key) continue;
    if (key.length > 512 || /[\s\x00-\x1f]/.test(key)) throw fail('Zadejte platný API klíč.');
    keys[id] = seal(key, await mailKey(settings));
  }
  const value = {
      service,
      host,
      port,
      user,
      from,
      ...(password ? { password: seal(password, await mailKey(settings)) } : current.password ? { password: current.password } : {}),
      ...(Object.keys(keys).length ? { keys } : {}),
    };
  await atomicJson(join(settings, 'mail.json'), value);
  return mailSettings(settings);
}
// What a refusal of an e-mail service means; the service's reply body is never shown (it may repeat the message).
function serviceError(name, status) {
  const message =
    status === 401 || status === 403
      ? `Služba ${name} odmítla API klíč (HTTP ${status}).`
      : status === 400 || status === 422
        ? `Služba ${name} odmítla odesílatele nebo adresu, odesílatel musí být u služby ověřený (HTTP ${status}).`
        : status === 429
          ? `Služba ${name} hlásí překročený limit odesílání, zkuste to později (HTTP ${status}).`
          : `Služba ${name} má potíže, zkuste to později (HTTP ${status}).`;
  return Object.assign(Error(message), { status: 502 });
}
// Sends one message over the chosen service's HTTPS API: only POST to its fixed address, the key only in a header.
async function sendOverApi(api, key, from, mail, request) {
  let response;
  try {
    response = await request(api.url, {
      method: 'POST',
      headers: { ...api.headers(key), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(api.body(from, mail)),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(Error(`Služba ${api.name} není dostupná.`), { status: 502 });
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw serviceError(api.name, response.status);
}
// Sends one message through the instance's service; fails honestly when it is not set or refuses.
// options.fetch stands in for the network in tests (a local replacement of the API).
export async function sendMail(settings, mail, options = {}) {
  const value = await stored(settings),
    service = mailServices.includes(value.service) ? value.service : 'smtp';
  const ready = service === 'smtp' ? value.host : value.keys?.[service];
  if (!ready || !value.from || !validEmail(value.from) || !validEmail(mail.to))
    throw Object.assign(Error('Odesílání e-mailů není nastavené.'), { status: 503 });
  if (mail.replyTo && !validEmail(mail.replyTo)) mail = { ...mail, replyTo: undefined };
  if (service !== 'smtp')
    return sendOverApi(
      mailApis[service],
      open(value.keys[service], await mailKey(settings)),
      value.from,
      mail,
      options.fetch || globalThis.fetch,
    );
  const local = localHosts.includes(value.host);
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: value.host,
    port: value.port,
    secure: value.port === 465,
    requireTLS: !local,
    ignoreTLS: local && ![465, 587].includes(value.port),
    auth: value.user ? { user: value.user, pass: value.password ? open(value.password, await mailKey(settings)) : '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({ ...mail, from: value.from });
    if (!result.accepted?.length || result.rejected?.length) throw Error('Mail rejected');
  } finally {
    transport.close();
  }
}
