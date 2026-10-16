import { supportedFieldTypes, fieldWidths, textPatternTypes, fieldLimits } from '../field-catalog.ts';
import { validValuePattern, readSequences, planGeneratedRows, sequenceWrite } from './generated-values.ts';
import { readFile, lstat, writeFile, mkdir, rename, unlink, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Problem } from './store.ts';
import type { Store, Schema, Row } from './store.ts';
import { fileInFolder } from '../file-field.ts';
import { pruneBackups } from './backups.ts';
export const fieldTypes = supportedFieldTypes;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export function identifier(v: string) {
  return (
    typeof v === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v)
  );
}
export function scalarProblem(type: string, value: string) {
  if (type === 'checkbox' && !['', 'true', 'false'].includes(value)) return 'hodnota musí být ano/ne';
  if (!value) return '';
  if (type === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) return 'hodnota není číslo';
  if (
    type === 'date' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    return 'hodnota není platné datum';
  if (type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) return 'hodnota není platný čas';
  return '';
}
// Field types with a default value; for the others a default is not kept (it makes no sense there).
export const defaultValueTypes = [
  'checkbox',
  'text',
  'short_text',
  'textarea',
  'long_text',
  'markdown',
  'number',
  'color',
  'url',
  'email',
];
// A default value is checked like a value of the field.
export function defaultProblem(f: { type: string; maxlen?: number; pattern?: string }, value: string) {
  const scalar = scalarProblem(f.type, value);
  if (scalar) return scalar;
  if (!value) return '';
  if (value.length > (f.maxlen ?? fieldLimits.valueLength)) return 'hodnota je delší než povolená délka';
  if (f.pattern && !patternMatches(f.pattern, value)) return 'hodnota neodpovídá patternu';
  if (f.type === 'color' && !/^#[\da-f]{6}$/i.test(value)) return 'použijte barvu #RRGGBB';
  if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'hodnota není e-mail';
  if (f.type === 'url')
    try {
      if (!['http:', 'https:'].includes(new URL(value).protocol)) return 'hodnota není webová adresa';
    } catch {
      return 'hodnota není webová adresa';
    }
  return '';
}
export function patternMatches(pattern: string, value: string) {
  new RegExp(pattern, 'u');
  return new RegExp('^(?:' + pattern + ')(?![\\s\\S])', 'u').test(value);
}
export function validateStructure(input: unknown): Schema {
  if (!object(input) || !object(input.lists) || !Number.isInteger(input.version) || input.version < 1)
    throw new Problem(422, 'Vyplňte platnou verzi a seznam kolekcí.');
  if (input.settings !== undefined)
    throw new Problem(422, 'Nastavení editoru obsahu patří do cms/settings.json, nikoli do struktury.');
  if (Object.keys(input.lists).length > fieldLimits.collections) throw new Problem(422, 'Nejvýše 100 kolekcí.');
  for (const [name, d] of Object.entries(input.lists)) {
    if (
      !identifier(name) ||
      !object(d) ||
      typeof d.label !== 'string' ||
      !d.label.trim() ||
      !object(d.columns) ||
      !Object.hasOwn(d.columns, d.key)
    )
      throw new Problem(422, `${name}: kolekce potřebuje platný kód, název, pole a klíč.`);
    for (const [key, f] of Object.entries(d.columns)) {
      if (
        !identifier(key) ||
        !object(f) ||
        !fieldTypes.includes(f.type) ||
        typeof f.label !== 'string' ||
        !f.label.trim()
      )
        throw new Problem(422, `${d.label}: neplatné pole ${key}.`);
      if (f.type === 'generated' && (!validValuePattern(f.valuePattern) || f.default !== undefined))
        throw new Problem(422, f.label + ': vyplňte vzorec s alespoň #; generované pole nemá výchozí hodnotu.');
      if (f.width !== undefined && !fieldWidths.includes(f.width))
        throw new Problem(422, `${f.label}: neplatná šířka formuláře.`);
      if (f.maxlen !== undefined && (!Number.isInteger(f.maxlen) || f.maxlen < 1 || f.maxlen > fieldLimits.valueLength))
        throw new Problem(422, `${f.label}: délka musí být 1 až 300000.`);
      if (f.pattern !== undefined) {
        if (!textPatternTypes.includes(f.type))
          throw new Problem(422, `${f.label}: pattern je pouze pro textová pole.`);
        if (typeof f.pattern !== 'string' || f.pattern.length > fieldLimits.regexLength)
          throw new Problem(422, `${f.label}: neplatný pattern.`);
        try {
          patternMatches(f.pattern, '');
        } catch {
          throw new Problem(422, `${f.label}: pattern není platný regulární výraz.`);
        }
      }
      if (f.type === 'checkbox' && f.default !== undefined && !['true', 'false'].includes(f.default))
        throw new Problem(422, `${f.label}: výchozí hodnota musí být ano/ne.`);
      if (f.default !== undefined && typeof f.default !== 'string')
        throw new Problem(422, `${f.label}: výchozí hodnota musí být text.`);
      if (f.default !== undefined && f.type !== 'generated' && !defaultValueTypes.includes(f.type)) delete f.default;
      else if (f.default) {
        const problem = defaultProblem(f, f.default);
        if (problem) throw new Problem(422, `${f.label}: výchozí hodnota – ${problem}.`);
      }
      for (const flag of ['required', 'readonly', 'editableOnCreate'])
        if (f[flag] !== undefined && typeof f[flag] !== 'boolean')
          throw new Problem(422, `${f.label}: neplatné nastavení ${flag}.`);
      if (f.type === 'list' && (!identifier(f.list) || !Object.hasOwn(input.lists, f.list)))
        throw new Problem(422, `${d.label} / ${f.label}: zvolte existující cílovou kolekci.`);
      if (
        ['file', 'media'].includes(f.type) &&
        (!identifier(f.folder) || !Object.hasOwn(input.folders || {}, f.folder))
      )
        throw new Problem(422, `${d.label} / ${f.label}: vyberte složku souborů.`);
    }
    for (const p of ['display', 'group']) {
      const value = d[p],
        refs = value === undefined ? [] : typeof value === 'string' && p === 'display' ? [value] : value;
      if (!Array.isArray(refs) || refs.some((key) => !Object.hasOwn(d.columns, key)))
        throw new Problem(422, `${d.label}: ${p} odkazuje na neexistující pole.`);
    }
  }
  if (input.folders !== undefined && !object(input.folders)) throw new Problem(422, 'Neplatný seznam složek.');
  for (const [name, f] of Object.entries(input.folders || {}))
    if (
      !identifier(name) ||
      !object(f) ||
      typeof f.label !== 'string' ||
      !f.label.trim() ||
      !['img', 'other'].includes(f.type)
    )
      throw new Problem(422, `Složka ${name}: neplatný kód, název nebo typ.`);
    else if (f.maxSizeMb !== undefined && !(Number.isInteger(f.maxSizeMb) && f.maxSizeMb >= 1 && f.maxSizeMb <= 100))
      throw new Problem(422, `Složka ${name}: maximální velikost souboru musí být celé číslo 1–100 MB.`);
  return input as Schema;
}
export function planStructure(
  before: Schema,
  after: Schema,
  data: Record<string, Row[]>,
  overrides: Record<string, Row[]> = {},
  finalize?: (rows: Record<string, Row[]>) => Record<string, Row[]>,
) {
  const next: Record<string, Row[]> = {};
  for (const name of Object.keys(before.lists))
    if (!Object.hasOwn(after.lists, name) && (data[name]?.length || 0))
      throw new Problem(422, `Kolekce „${before.lists[name].label}“ obsahuje záznamy a nelze ji odstranit.`);
  for (const [name, d] of Object.entries(after.lists)) {
    const rows = data[name] || [];
    for (const key of Object.keys(before.lists[name]?.columns || {}))
      if (!Object.hasOwn(d.columns, key) && rows.some((r) => !!r[key]))
        throw new Problem(
          422,
          `Pole „${before.lists[name].columns[key].label}“ obsahuje data. Nejprve je převeďte nebo vyprázdněte.`,
        );
    next[name] = rows.map((r) =>
      Object.fromEntries(
        Object.entries(d.columns).map(([key, f]) => [
          key,
          r[key] ?? f.default ?? (f.type === 'checkbox' ? 'false' : ''),
        ]),
      ),
    );
    if (Object.hasOwn(overrides, name))
      next[name] = overrides[name].map((raw) => {
        if (!object(raw) || Object.keys(raw).some((key) => !Object.hasOwn(d.columns, key)))
          throw new Problem(422, 'Záznam obsahuje neplatná pole.');
        return Object.fromEntries(
          Object.entries(d.columns).map(([key, f]) => [
            key,
            raw[key] ?? f.default ?? (f.type === 'checkbox' ? 'false' : ''),
          ]),
        );
      });
  }
  if (finalize) Object.assign(next, finalize(next));
  for (const [name, d] of Object.entries(after.lists)) {
    const keys = new Set<string>();
    for (const row of next[name]) {
      if (!row[d.key]?.trim())
        throw new Problem(422, d.label + ' / ' + d.columns[d.key].label + ': vyplňte jedinečný klíč.');
      if (keys.has(row[d.key]))
        throw new Problem(
          422,
          d.columns[d.key].label +
            ': hodnota ' +
            JSON.stringify(row[d.key]) +
            ' již existuje. Zadejte jiný jedinečný klíč.',
        );
      keys.add(row[d.key]);
      for (const [key, f] of Object.entries(d.columns)) {
        const v = row[key];
        if (typeof v !== 'string') throw new Problem(422, `${f.label}: očekáván text.`);
        if (f.required && !v.trim())
          throw new Problem(
            422,
            `${d.label} / ${f.label}: existující hodnota je prázdná. Doplňte výchozí hodnotu nebo zrušte povinnost.`,
          );
        if (v.length > (f.maxlen ?? fieldLimits.valueLength))
          throw new Problem(422, `${d.label} / ${f.label}: existující obsah je delší než nový limit.`);
        if (v && f.pattern && !patternMatches(f.pattern, v))
          throw new Problem(422, `${d.label} / ${f.label}: existující hodnota neodpovídá patternu.`);
        if (v && f.type === 'list' && !next[f.list!].some((target) => target[after.lists[f.list!].key] === v))
          throw new Problem(422, `${d.label} / ${f.label}: odkaz „${v}“ nemá cílový záznam.`);
        if (v && ['file', 'media'].includes(f.type) && !fileInFolder(v, f.folder!))
          throw new Problem(422, `${d.label} / ${f.label}: existující soubor není ze složky ${f.folder}.`);
        const scalar = scalarProblem(f.type, v);
        if (scalar) throw new Problem(422, `${d.label} / ${f.label}: ${scalar}.`);
        if (v && f.type === 'color' && !/^#[\da-f]{6}$/i.test(v))
          throw new Problem(422, `${f.label}: existující hodnota není barva.`);
        if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
          throw new Problem(422, `${f.label}: existující hodnota není e-mail.`);
        if (v && f.type === 'url') {
          try {
            if (!['http:', 'https:'].includes(new URL(v).protocol)) throw Error();
          } catch {
            throw new Problem(422, `${f.label}: existující hodnota není URL.`);
          }
        }
      }
    }
  }
  return next;
}
export async function schemaSnapshot(root: string) {
  const text = await readFile(join(root, 'schema/structure.json'), 'utf8');
  return { schema: JSON.parse(text) as Schema, revision: createHash('sha256').update(text).digest('hex') };
}
import { atomicWrite as atomic } from '../../../packages/content/files.mjs';
export async function recoverStructure(root: string) {
  const path = join(root, '.structure-transaction.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(path, 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const [target, temp] of Object.entries(journal.assets || {}) as [string, string][]) {
    if (
      !/^media\/[\w-]+\/[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u.test(target) ||
      target.includes('..') ||
      !/^backups\/[a-f0-9-]+-design-asset\.tmp$/.test(temp)
    )
      throw Error('Invalid asset recovery path');
    try {
      const a = await lstat(join(root, target)),
        b = await lstat(join(root, temp));
      if (a.ino === b.ino && a.dev === b.dev) await unlink(join(root, target));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    await unlink(join(root, temp)).catch(() => {});
  }
  for (const [name, text] of Object.entries(journal.before) as [string, string | null][]) {
    if (!/^data\/[\w-]+\.json$|^schema\/structure\.json$|^\.cmstudio-sequences\.json$/.test(name))
      throw Error('Invalid recovery path');
    if (text === null) await unlink(join(root, name)).catch(() => {});
    else await atomic(join(root, name), text);
  }
  for (const dir of [...(journal.createdDirs || [])].sort((a: string, b: string) => b.length - a.length)) {
    if (typeof dir !== 'string' || !/^media(?:\/[\w-]+)?$/.test(dir)) throw Error('Invalid recovery directory');
    try {
      await rmdir(join(root, dir));
    } catch (e: any) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
    }
  }
  await unlink(path);
}
export async function prepareStructure(
  store: Store,
  input: unknown,
  revision: string,
  options: { rows?: Record<string, Row[]>; assets?: Set<string> } = {},
) {
  const root = store.root,
    old = await schemaSnapshot(root);
  if (old.revision !== revision) throw new Problem(409, 'Struktura se mezitím změnila. Obnovte ji.');
  const schema = validateStructure(structuredClone(input));
  for (const folder of Object.keys(old.schema.folders || {}))
    if (!Object.hasOwn(schema.folders || {}, folder)) {
      let files: string[] = [];
      try {
        files = await readdir(join(root, 'media', folder));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (files.length)
        throw new Problem(422, `Složka „${old.schema.folders![folder].label}“ obsahuje soubory a nelze ji odstranit.`);
    }
  const data: Record<string, Row[]> = {};
  for (const name of new Set([...Object.keys(old.schema.lists), ...Object.keys(schema.lists)])) {
    try {
      data[name] = JSON.parse(await readFile(join(root, 'data', name + '.json'), 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      data[name] = [];
    }
  }
  const sequences = await readSequences(root);
  let sequenceState = sequences.state;
  const planned = planStructure(old.schema, schema, data, options.rows, (rows) => {
    const generation = planGeneratedRows(schema, rows, old.schema, data, sequences.state);
    sequenceState = generation.state;
    return generation.rows;
  });
  for (const [name, def] of Object.entries(schema.lists))
    for (const [key, field] of Object.entries(def.columns))
      if (['file', 'media'].includes(field.type))
        for (const row of planned[name])
          if (row[key]) {
            const path = fileInFolder(row[key], field.folder!);
            const { stat } = await import('node:fs/promises');
            try {
              if (!path || (!options.assets?.has(path) && !(await stat(join(root, 'media', path))).isFile()))
                throw Error();
            } catch {
              throw new Problem(422, `${def.label} / ${field.label}: soubor neexistuje ve zvolené složce.`);
            }
          }
  return { root, old, schema, data, planned, sequenceWrites: sequenceWrite(sequences.state, sequenceState) };
}
import { commitWorkingTransaction } from './working-transaction.ts';
export async function writeStructure(store: Store, input: unknown, revision: string) {
  const { root, old, schema, data, planned, sequenceWrites } = await prepareStructure(store, input, revision);
  schema.version = old.schema.version + 1;
  const writes: Record<string, string> = { ...sequenceWrites };
  for (const [name, rows] of Object.entries(planned))
    if (JSON.stringify(rows) !== JSON.stringify(data[name]) || !Object.hasOwn(old.schema.lists, name))
      writes['data/' + name + '.json'] = JSON.stringify(rows, null, 2) + '\n';
  writes['schema/structure.json'] = JSON.stringify(schema, null, 2) + '\n';
  const before: Record<string, string | null> = {};
  for (const name of Object.keys(writes)) {
    try {
      before[name] = await readFile(join(root, name), 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      before[name] = null;
    }
  }
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'backups'), { recursive: true });
  await writeFile(
    join(root, 'backups', `${Date.now()}-structure-${randomUUID()}.json`),
    JSON.stringify({ schema: old.schema, before }, null, 2) + '\n',
  );
  await commitWorkingTransaction(root, writes, before, undefined, undefined, {}, true);
  await pruneBackups(root).catch(() => {});
  return { schema, schemaRevision: (await schemaSnapshot(root)).revision, lists: await store.all() };
}
