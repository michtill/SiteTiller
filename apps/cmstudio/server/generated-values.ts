import { fieldLimits } from '../field-catalog.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Problem, type Schema, type Row } from './store.ts';
export const sequencePath = '.cmstudio-sequences.json';
export type Sequences = {
  version: 1;
  manualValues?: Record<string, Record<string, string[]>>;
  counters: Record<string, Record<string, string>>;
};
export async function readSequences(root: string) {
  let text: string | null;
  try {
    text = await readFile(join(root, sequencePath), 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    text = null;
  }
  const state = text === null ? { version: 1, counters: {} } : JSON.parse(text);
  if (
    !state ||
    state.version !== 1 ||
    !state.counters ||
    typeof state.counters !== 'object' ||
    Array.isArray(state.counters)
  )
    throw new Problem(422, 'Neplatné počítadlo generovaných hodnot.');
  for (const fields of Object.values(state.counters) as any[]) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Problem(422, 'Neplatné počítadlo.');
    for (const value of Object.values(fields))
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Problem(422, 'Neplatné počítadlo.');
  }
  if (state.manualValues !== undefined) {
    if (!state.manualValues || typeof state.manualValues !== 'object' || Array.isArray(state.manualValues))
      throw new Problem(422, 'Neplatná evidence vlastních hodnot.');
    for (const fields of Object.values(state.manualValues) as any[]) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        throw new Problem(422, 'Neplatná evidence vlastních hodnot.');
      for (const values of Object.values(fields))
        if (!Array.isArray(values) || values.some((v) => typeof v !== 'string'))
          throw new Problem(422, 'Neplatná evidence vlastních hodnot.');
    }
  }
  return { state: state as Sequences, text };
}
export function validValuePattern(pattern: unknown) {
  return (
    typeof pattern === 'string' &&
    pattern.length <= fieldLimits.valuePatternLength &&
    pattern.includes('#') &&
    !/[\x00-\x1f]/.test(pattern)
  );
}
export function generatedValue(pattern: string, number: bigint) {
  return pattern.replace(/#+/g, (run) => number.toString().padStart(run.length, '0'));
}
function sequenceNumber(pattern: string, value: string) {
  const escaped = pattern
    .split(/(#+)/)
    .map((part) => (/^#+$/.test(part) ? '(\\d+)' : part.replace(/[.*+?^()|[\]\\{}$]/g, '\\$&')))
    .join('');
  const match = value.match(new RegExp('^' + escaped + '$'));
  if (!match) return 0n;
  const numbers = match.slice(1).map((v) => BigInt(v));
  return numbers.length && numbers.every((n) => n === numbers[0]) && generatedValue(pattern, numbers[0]) === value
    ? numbers[0]
    : 0n;
}
export function planGeneratedRows(
  schema: Schema,
  proposed: Record<string, Row[]>,
  beforeSchema: Schema,
  before: Record<string, Row[]>,
  initial: Sequences,
) {
  const state = structuredClone(initial),
    rows = structuredClone(proposed);
  for (const [name, def] of Object.entries(schema.lists)) {
    const previous = before[name] || [],
      oldKey = beforeSchema.lists[name]?.key || def.key,
      oldRows = new Map(previous.map((row) => [row[oldKey], row]));
    for (const [field, f] of Object.entries(def.columns)) {
      if (f.type !== 'generated') continue;
      if (!validValuePattern(f.valuePattern)) throw new Problem(422, f.label + ': vzorec musí obsahovat alespoň #.');
      let allocated = false,
        high = BigInt(state.counters[name]?.[field] || '0');
      const manual = new Set(state.manualValues?.[name]?.[field] || []),
        used = new Set(previous.map((row) => row[field]));
      for (const row of previous) {
        const v = row[field];
        if (typeof v === 'string' && !manual.has(v)) {
          const n = sequenceNumber(f.valuePattern!, v);
          if (n > high) high = n;
        }
      }
      const reserved = new Map<string, number>();
      if (field === def.key)
        for (const candidate of rows[name] || []) {
          const value = candidate?.[field];
          if (typeof value === 'string' && value) reserved.set(value, (reserved.get(value) || 0) + 1);
        }
      const rememberManual = (value: string) => {
        if (sequenceNumber(f.valuePattern!, value) > 0n) {
          manual.add(value);
          state.manualValues ??= {};
          state.manualValues[name] ??= {};
          state.manualValues[name][field] = [...manual];
        }
      };
      for (const row of rows[name] || []) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Problem(422, 'Neplatný záznam.');
        const existing = row[oldKey] ? oldRows.get(row[oldKey]) : undefined;
        if (existing) {
          const value = existing[field] ?? '';
          if ((row[field] ?? '') !== value) {
            if (f.readonly !== false) throw new Problem(422, f.label + ': uloženou generovanou hodnotu nelze měnit.');
            if (typeof row[field] !== 'string') throw new Problem(422, f.label + ': očekáván text.');
            rememberManual(row[field]);
          } else row[field] = value;
        } else {
          while (
            used.has(generatedValue(f.valuePattern!, high + 1n)) ||
            (reserved.get(generatedValue(f.valuePattern!, high + 1n)) || 0) >
              (row[field] === generatedValue(f.valuePattern!, high + 1n) ? 1 : 0)
          )
            high++;
          const number = high + 1n,
            next = generatedValue(f.valuePattern!, number),
            value = row[field];
          // A new record may bring its own value when the field is editable, or editable for a new item.
          const ownValue = f.readonly === false || f.editableOnCreate === true;
          if (value && value !== next && !ownValue)
            throw new Problem(422, f.label + ': hodnotu přiděluje server při založení záznamu.');
          if (value !== undefined && value !== null && typeof value !== 'string')
            throw new Problem(422, f.label + ': očekáván text.');
          const consumes =
            !value ||
            value === next ||
            (ownValue && (value.match(/\d+/g) || []).some((digits: string) => BigInt(digits) === number));
          if (consumes) {
            allocated = true;
            high++;
            row[field] = value || next;
          } else {
            row[field] = value;
            rememberManual(value);
          }
          used.add(row[field]);
        }
      }
      if (allocated && high > BigInt(state.counters[name]?.[field] || '0')) {
        state.counters[name] ??= {};
        state.counters[name][field] = high.toString();
      }
    }
  }
  return { rows, state };
}
export function sequenceWrite(before: Sequences, after: Sequences): Record<string, string> {
  return JSON.stringify(before) === JSON.stringify(after)
    ? {}
    : { [sequencePath]: JSON.stringify(after, null, 2) + '\n' };
}

export function previewGeneratedValues(store: import('./store.ts').Store, name: string) {
  return store.exclusive(async () => {
    const schema = await store.schema();
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name) || !Object.hasOwn(schema.lists, name))
      throw new Problem(404, 'Neznámá kolekce.');
    const def = schema.lists[name],
      current = await store.snapshot(name),
      sequences = await readSequences(store.root);
    const generation = planGeneratedRows(
      { ...schema, lists: { [name]: def } },
      { [name]: [{}] },
      schema,
      { [name]: current.rows },
      sequences.state,
    );
    const { schemaSnapshot } = await import('./structure.ts');
    return {
      values: Object.fromEntries(
        Object.entries(def.columns)
          .filter(([, f]) => f.type === 'generated')
          .map(([key]) => [key, generation.rows[name][0][key]]),
      ),
      schemaRevision: (await schemaSnapshot(store.root)).revision,
      collectionRevision: current.revision,
    };
  });
}
