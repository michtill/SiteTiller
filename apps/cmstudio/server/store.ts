import { fieldLimits } from '../field-catalog.ts';
import { readSequences, planGeneratedRows, sequenceWrite } from './generated-values.ts';
import { commitWorkingTransaction } from './working-transaction.ts';
import { pruneBackups } from './backups.ts';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeStructure, schemaSnapshot, scalarProblem, patternMatches } from './structure.ts';
import { fileInFolder } from '../file-field.ts';
export type Field = {
  type: string;
  label: string;
  hint?: string;
  width?: string;
  required?: boolean;
  maxlen?: number;
  pattern?: string;
  list?: string;
  folder?: string;
  readonly?: boolean;
  editableOnCreate?: boolean;
  default?: string;
  valuePattern?: string;
};
export type Schema = {
  version: number;
  folders?: Record<string, { label: string; type: 'img' | 'other'; maxSizeMb?: number }>;
  lists: Record<
    string,
    { label: string; key: string; display?: string | string[]; group?: string[]; columns: Record<string, Field> }
  >;
};
export type Row = Record<string, string>;
export class Problem extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  root: string;
  constructor(root: string) {
    this.root = root;
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }
  async schema(): Promise<Schema> {
    return JSON.parse(await readFile(join(this.root, 'schema', 'structure.json'), 'utf8'));
  }
  async snapshot(name: string) {
    const schema = await this.schema();
    if (!/^[\w-]+$/.test(name) || !Object.hasOwn(schema.lists, name)) throw new Problem(404, 'Neznámý seznam.');
    let text;
    try {
      text = await readFile(join(this.root, 'data', name + '.json'), 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      text = '[]\n';
    }
    return { rows: JSON.parse(text) as Row[], revision: createHash('sha256').update(text).digest('hex') };
  }
  async all() {
    const schema = await this.schema();
    return Object.fromEntries(
      await Promise.all(Object.keys(schema.lists).map(async (name) => [name, await this.snapshot(name)])),
    );
  }
  updateSchema(input: unknown, revision: string) {
    const task = this.queue.then(() => writeStructure(this, input, revision));
    this.queue = task.catch(() => {});
    return task;
  }
  update(name: string, input: unknown, revision: string, schemaRevision?: string, rename?: unknown) {
    const task = this.queue.then(async () => {
      if (schemaRevision !== undefined && (await schemaSnapshot(this.root)).revision !== schemaRevision)
        throw new Problem(409, 'Struktura se změnila. Znovu načtěte editor obsahu.');
      return this.write(name, input, revision, rename);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async validateRows(
    name: string,
    input: unknown,
    collections?: Record<string, Row[]>,
    newAssets?: Set<string>,
    candidateAssetsOnly = false,
  ) {
    const schema = await this.schema();
    if (!/^[\w-]+$/.test(name) || !Object.hasOwn(schema.lists, name)) throw new Problem(404, 'Neznámý seznam.');
    const def = schema.lists[name],
      snapshot = async (key: string) =>
        collections && Object.hasOwn(collections, key) ? { rows: collections[key] } : this.snapshot(key);
    if (!Array.isArray(input) || input.length > fieldLimits.rowsPerCollection)
      throw new Problem(422, 'Neplatný seznam.');
    const rows: Row[] = [],
      keys = new Set<string>();
    for (const raw of input) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Problem(422, 'Neplatný záznam.');
      const row: Row = {};
      if (Object.keys(raw).some((k) => !Object.hasOwn(def.columns, k)))
        throw new Problem(422, 'Záznam obsahuje pole mimo schéma.');
      for (const [key, field] of Object.entries(def.columns)) {
        const value = raw[key] ?? field.default ?? (field.type === 'checkbox' ? 'false' : '');
        if (typeof value !== 'string') throw new Problem(422, `${field.label}: očekáván text.`);
        if (field.required && !value.trim()) throw new Problem(422, `${field.label}: povinné pole.`);
        if (value.length > (field.maxlen ?? fieldLimits.valueLength))
          throw new Problem(422, `${field.label}: text je příliš dlouhý.`);
        if (value && field.pattern && !patternMatches(field.pattern, value))
          throw new Problem(422, `${field.label}: hodnota neodpovídá patternu.`);
        const scalar = scalarProblem(field.type, value);
        if (scalar) throw new Problem(422, `${field.label}: ${scalar}.`);
        if (value && ['file', 'media'].includes(field.type)) {
          const path = field.folder ? fileInFolder(value, field.folder) : null;
          if (!path) throw new Problem(422, `${field.label}: vyberte soubor z určené složky.`);
          if (candidateAssetsOnly && !newAssets?.has(path))
            throw new Problem(422, `${field.label}: historický soubor chybí v obnově.`);
          const { stat } = await import('node:fs/promises');
          try {
            if (!newAssets?.has(path) && !(await stat(join(this.root, 'media', path))).isFile()) throw Error();
          } catch {
            throw new Problem(422, `${field.label}: soubor neexistuje.`);
          }
        }
        if (value && field.type === 'url') {
          try {
            const u = new URL(value);
            if (!['http:', 'https:'].includes(u.protocol)) throw Error();
          } catch {
            throw new Problem(422, `${field.label}: neplatná webová adresa.`);
          }
        }
        if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          throw new Problem(422, `${field.label}: neplatný e-mail.`);
        if (value && field.type === 'color' && !/^#[\da-f]{6}$/i.test(value))
          throw new Problem(422, `${field.label}: použijte barvu #RRGGBB.`);
        if (value && field.type === 'list' && field.list) {
          const linked = await snapshot(field.list);
          if (!linked.rows.some((r) => r[schema.lists[field.list!].key] === value))
            throw new Problem(422, `${field.label}: odkazovaná položka neexistuje.`);
        }
        row[key] = value;
      }
      const key = row[def.key];
      if (!key?.trim()) throw new Problem(422, def.columns[def.key].label + ': vyplňte jedinečný klíč.');
      if (keys.has(key))
        throw new Problem(
          422,
          def.columns[def.key].label +
            ': hodnota ' +
            JSON.stringify(key) +
            ' již existuje. Zadejte jiný jedinečný klíč.',
        );
      keys.add(key);
      rows.push(row);
    }
    for (const [other, otherDef] of Object.entries(schema.lists))
      for (const [col, field] of Object.entries(otherDef.columns))
        if (field.type === 'list' && field.list === name) {
          const dependent = other === name ? rows : (await snapshot(other)).rows;
          for (const row of dependent)
            if (row[col] && !keys.has(row[col]))
              throw new Problem(422, `Položku nelze odstranit nebo přejmenovat: používá ji seznam ${otherDef.label}.`);
        }
    // A link to the own collection (a parent page) never makes a cycle, for every writer (documentation 3.8).
    const shown = Array.isArray(def.display) ? def.display[0] : def.display,
      title = (key: string) => {
        const row = rows.find((r) => r[def.key] === key);
        return (shown && row?.[shown]) || key;
      };
    for (const [col, field] of Object.entries(def.columns))
      if (field.type === 'list' && field.list === name) {
        const parents = new Map(rows.map((r) => [r[def.key], r[col]]));
        for (const row of rows) {
          const key = row[def.key],
            parent = row[col];
          if (!parent) continue;
          if (parent === key) throw new Problem(422, `${title(key)} nemůže být pod sebou samou (${field.label}).`);
          const seen = new Set([parent]);
          for (let next = parents.get(parent); next && !seen.has(next); next = parents.get(next)) {
            if (next === key)
              throw new Problem(
                422,
                `${title(key)} nemůže být pod ${title(parent)}, protože ${title(parent)} je pod ${title(key)} (${field.label}).`,
              );
            seen.add(next);
          }
        }
      }
    return rows;
  }
  private async write(name: string, input: unknown, revision: string, rename?: unknown) {
    const schema = await this.schema(),
      old = await this.snapshot(name),
      def = schema.lists[name];
    if (old.revision !== revision)
      throw new Problem(409, 'Obsah se mezitím změnil. Znovu načtěte seznam a zopakujte úpravu.');
    if (!Array.isArray(input)) throw new Problem(422, 'Neplatný seznam.');
    // A key renamed in the form (documentation 3.3): every link to it, in any collection, takes the new key in the
    // same write. Only an explicit rename of an existing key that is gone from the saved rows qualifies.
    const linked: Record<string, Row[]> = {};
    let renamed = false;
    if (rename !== undefined) {
      const { from, to } = (rename || {}) as { from?: unknown; to?: unknown };
      if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        !from ||
        !to.trim() ||
        from === to ||
        !old.rows.some((row) => row[def.key] === from) ||
        input.some((row: any) => row?.[def.key] === from) ||
        !input.some((row: any) => row?.[def.key] === to)
      )
        throw new Problem(422, 'Neplatné přejmenování klíče.');
      for (const [other, otherDef] of Object.entries(schema.lists))
        for (const [col, field] of Object.entries(otherDef.columns))
          if (field.type === 'list' && field.list === name) {
            const rows: any[] = other === name ? input : linked[other] || (await this.snapshot(other)).rows;
            const next = rows.map((row) => {
              if (row?.[col] !== from) return row;
              renamed = true;
              return { ...row, [col]: to };
            });
            if (other === name) input = next;
            else linked[other] = next;
          }
    }
    const rowsInput = input as unknown[];
    const sequences = await readSequences(this.root),
      generation = planGeneratedRows(
        { ...schema, lists: { [name]: def } },
        { [name]: rowsInput },
        schema,
        { [name]: old.rows },
        sequences.state,
      );
    const rows = await this.validateRows(name, generation.rows[name], { ...linked, [name]: generation.rows[name] });
    const others: Record<string, Row[]> = {};
    for (const [other, otherRows] of Object.entries(linked))
      others[other] = await this.validateRows(other, otherRows, { ...linked, [name]: rows });
    await mkdir(join(this.root, 'backups'), { recursive: true });
    await writeFile(
      join(this.root, 'backups', `${Date.now()}-${name}-${randomUUID()}.json`),
      JSON.stringify(old.rows, null, 2) + '\n',
    );
    const writes: Record<string, string> = {
      ['data/' + name + '.json']: JSON.stringify(rows, null, 2) + '\n',
      ...Object.fromEntries(
        Object.entries(others).map(([other, otherRows]) => [
          'data/' + other + '.json',
          JSON.stringify(otherRows, null, 2) + '\n',
        ]),
      ),
      ...sequenceWrite(sequences.state, generation.state),
    };
    await mkdir(join(this.root, 'data'), { recursive: true });
    const before: Record<string, string | null> = {};
    for (const path of Object.keys(writes)) {
      try {
        before[path] = await readFile(join(this.root, path), 'utf8');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        before[path] = null;
      }
    }
    await commitWorkingTransaction(this.root, writes, before);
    await pruneBackups(this.root).catch(() => {});
    return { ...(await this.snapshot(name)), ...(renamed ? { renamedLinks: true } : {}) };
  }
}
