// Sending e-mail (documentation 2.8): one mail server of the instance for the password reset and for the forms of the
// website running in the instance. settings/mail.json keeps server, port, user and sender; the server password is
// encrypted with settings/mail.key (600) and never shown again. Nothing comes from environment variables.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { atomicJson, readJson, validEmail } from './index.mjs';
export { validEmail };
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
  const value = await stored(settings);
  return {
    host: value.host || '',
    port: value.port || 587,
    user: value.user || '',
    from: value.from || '',
    passwordSet: !!value.password,
    configured: !!(value.host && value.from),
  };
}
// Saves the screen's values; an empty password keeps the stored one.
export async function saveMailSettings(settings, input) {
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
    value = {
      host,
      port,
      user,
      from,
      ...(password ? { password: seal(password, await mailKey(settings)) } : current.password ? { password: current.password } : {}),
    };
  await atomicJson(join(settings, 'mail.json'), value);
  return mailSettings(settings);
}
// Sends one message through the instance's mail server; fails honestly when it is not set or refuses.
export async function sendMail(settings, mail) {
  const value = await stored(settings);
  if (!value.host || !value.from || !validEmail(value.from) || !validEmail(mail.to))
    throw Object.assign(Error('Odesílání e-mailů není nastavené.'), { status: 503 });
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
