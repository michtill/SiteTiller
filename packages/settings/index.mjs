import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../content/files.mjs';
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
export async function atomicJson(path, value, { mode = 0o600 } = {}) {
  await mkdir(join(path, '..'), { recursive: true });
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n', { mode });
}
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
export function passwordMatches(password, record) {
  if (typeof password !== 'string' || password.length > 256 || !record) return false;
  const actual = scryptSync(password, record.salt, 64),
    expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queues = new Map();
export async function updateSettings(path, value, expectedRevision) {
  const previous = queues.get(path) || Promise.resolve();
  let unlock;
  const held = new Promise((r) => (unlock = r));
  queues.set(
    path,
    previous.then(() => held),
  );
  await previous;
  try {
    const current = await readJson(path);
    if (revision(current) !== expectedRevision)
      throw Object.assign(Error('Nastavení se mezitím změnilo.'), { status: 409 });
    await atomicJson(path, value);
    return { settings: value, settingsRevision: revision(value) };
  } finally {
    unlock();
  }
}
export function validateShared(value, { current = {} } = {}) {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 200 ||
    !['light', 'dark'].includes(value.theme)
  )
    throw Object.assign(Error('Neplatné společné nastavení.'), { status: 422 });
  const result = { ...current, name: value.name.trim(), theme: value.theme };
  if (Object.hasOwn(value, 'language')) {
    if (!['cs', 'en'].includes(value.language)) throw Object.assign(Error('Neplatný jazyk rozhraní.'), { status: 422 });
    result.language = value.language;
  }
  // Default Content Editor mode, applied when the Editor is first opened after a start (live only without unpublished
  // changes). Saving it never switches the running Editor.
  if (Object.hasOwn(value, 'contentDefault')) {
    if (!['draft', 'live'].includes(value.contentDefault))
      throw Object.assign(Error('Neplatný režim editace obsahu.'), { status: 422 });
    result.contentDefault = value.contentDefault;
  }
  // Unused services sleep after these minutes, 0 = never (documentation 2.4, 2.6).
  if (Object.hasOwn(value, 'sleepMinutes')) {
    if (![0, 5, 15, 30, 60].includes(value.sleepMinutes))
      throw Object.assign(Error('Neplatná doba uspání.'), { status: 422 });
    result.sleepMinutes = value.sleepMinutes;
  }
  // The public draft preview (Shell, on the instance's public preview address).
  if (Object.hasOwn(value, 'publicPreview')) {
    if (typeof value.publicPreview !== 'boolean')
      throw Object.assign(Error('Neplatná volba veřejného náhledu.'), { status: 422 });
    result.publicPreview = value.publicPreview;
  }
  // The public preview address, set on Settings → Addresses and sharing (documentation 2.4); empty = the installation's.
  if (Object.hasOwn(value, 'publicPreviewOrigin')) {
    const text = String(value.publicPreviewOrigin ?? '').trim();
    if (text) {
      let url;
      try {
        url = new URL(text);
      } catch {}
      if (
        !url ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search ||
        url.hash
      )
        throw Object.assign(Error('Zadejte adresu náhledu jako https://subdomena.example.cz bez cesty.'), {
          status: 422,
        });
      result.publicPreviewOrigin = url.origin;
    } else result.publicPreviewOrigin = '';
  }
  // The administrator's e-mail (documentation 2.8): required on the Sending e-mail screen, which saves it here.
  if (Object.hasOwn(value, 'adminEmail')) {
    result.adminEmail = String(value.adminEmail ?? '').trim();
    if (!validEmail(result.adminEmail)) throw Object.assign(Error('Vyplňte platný e-mail správce.'), { status: 422 });
  }
  return result;
}
// A plain e-mail address (the same rule for the administrator, the sender and form recipients).
export const validEmail = (value) =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(value);
