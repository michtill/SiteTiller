import type { Schema, Row } from '../server/store.ts';
export function rowLabel(schema: Schema, name: string, row: Row) {
  const def = schema.lists[name];
  if (!def) return '';
  const fields = def.display ? (Array.isArray(def.display) ? def.display : [def.display]) : [def.key];
  return (
    fields
      .map((key) => row[key] || '')
      .filter(Boolean)
      .join(', ') ||
    row[def.key] ||
    'Nová položka'
  );
}
export function groupFields(schema: Schema, name: string) {
  const def = schema.lists[name];
  if (!def) return [];
  return (def.group || [])
    .filter((key) => Object.hasOwn(def.columns, key))
    .map((key) => ({ key, field: def.columns[key] }));
}
export function filterRows(schema: Schema, name: string, rows: Row[], filters: Record<string, string>, search: string) {
  const query = search.toLocaleLowerCase('cs');
  return rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        Object.entries(filters).every(([key, value]) => !value || row[key] === value) &&
        (!query ||
          Object.keys(schema.lists[name].columns).some((key) =>
            String(row[key] || '')
              .toLocaleLowerCase('cs')
              .includes(query),
          )),
    );
}
export function rowSubtitle(schema: Schema, name: string, row: Row, lists: Record<string, { rows: Row[] }>) {
  const groups = groupFields(schema, name);
  const parts = groups
    .map(({ key, field }) => {
      const target = field.list;
      return target && schema.lists[target]
        ? rowLabel(schema, target, lists[target]?.rows.find((r) => r[schema.lists[target].key] === row[key]) || {})
        : row[key];
    })
    .filter(Boolean);
  return parts.join(' · ') || row[schema.lists[name].key];
}
