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
export function validateShared(value, { current = {}, validateSiteUrl } = {}) {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 200 ||
    !['green', 'blue', 'plum', 'graphite', 'sand', 'black', 'light'].includes(value.theme)
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
  // The public draft preview (Shell, on the instance's public preview address).
  if (Object.hasOwn(value, 'publicPreview')) {
    if (typeof value.publicPreview !== 'boolean')
      throw Object.assign(Error('Neplatná volba veřejného náhledu.'), { status: 422 });
    result.publicPreview = value.publicPreview;
  }
  if (Object.hasOwn(value, 'siteUrl')) {
    if (typeof value.siteUrl !== 'string' || value.siteUrl.length > 2000 || typeof validateSiteUrl !== 'function')
      throw Object.assign(Error('Neplatná adresa webu.'), { status: 422 });
    try {
      result.siteUrl = validateSiteUrl(value.siteUrl);
    } catch {
      throw Object.assign(
        Error('Zadejte veřejnou HTTP/HTTPS adresu bez přihlašovacích údajů, nebo adresu této lokální instance.'),
        { status: 422 },
      );
    }
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
export async function migrateSharedSiteUrl(path, legacyPath, validateSiteUrl, fallback = '') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readJson(path);
    if (Object.hasOwn(current, 'siteUrl')) return current;
    let legacy = {};
    try {
      legacy = await readJson(legacyPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    // An address the current rules reject (e.g. a local URL on another port) must not stop the Shell from starting.
    let siteUrl = '';
    for (const candidate of [legacy.siteUrl, fallback].filter((v) => v !== undefined))
      try {
        siteUrl = validateSiteUrl(candidate);
        break;
      } catch {}
    try {
      return (await updateSettings(path, { ...current, siteUrl }, revision(current))).settings;
    } catch (e) {
      if (e.status !== 409) throw e;
    }
  }
  throw Object.assign(Error('Nastavení se mezitím změnilo.'), { status: 409 });
}
export async function readSharedSiteUrl(path, legacyValue, fallback = '') {
  if (!path) return legacyValue ?? fallback;
  const current = await readJson(path);
  return Object.hasOwn(current, 'siteUrl') ? current.siteUrl : (legacyValue ?? fallback);
}
