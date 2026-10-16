import type { SourceEvidence } from './web-source.ts';
export const normalizedSourceText = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
export function sourceQuote(source: SourceEvidence, quote: string) {
  return !!quote.trim() && normalizedSourceText(source.citationText).includes(normalizedSourceText(quote));
}
export function orderField(field: string, definition: any) {
  return (
    definition?.type === 'number' &&
    (/^(?:position|order|track_number|trackNumber)$/i.test(field) ||
      /^(?:pořadí|pořadí (?:skladby|položky|záznamu)(?:\s|$))/iu.test(definition.label || ''))
  );
}
function anchors(def: any) {
  const selected = (Array.isArray(def.display) ? def.display : [def.display]).filter(
    (field: any) =>
      typeof field === 'string' && ['text', 'short_text', 'textarea', 'long_text'].includes(def.columns[field]?.type),
  );
  return selected.length
    ? selected
    : Object.keys(def.columns).filter(
        (field) =>
          field !== def.key && ['text', 'short_text', 'textarea', 'long_text'].includes(def.columns[field]?.type),
      );
}
function citedName(source: SourceEvidence, facts: any[], collection: string, field: string, value: any) {
  return (
    typeof value === 'string' &&
    !!value &&
    facts.some(
      (fact) =>
        fact?.sourceId === source.id &&
        fact.collection === collection &&
        fact.field === field &&
        (fact.value === value ||
          (typeof fact.value === 'string' && normalizedSourceText(fact.value).includes(normalizedSourceText(value)))) &&
        typeof fact.quote === 'string' &&
        normalizedSourceText(fact.quote).includes(normalizedSourceText(value)) &&
        sourceQuote(source, fact.quote),
    )
  );
}
function visit(value: any, check: (value: any) => void) {
  if (!value || typeof value !== 'object') return;
  check(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child, check);
}
function albumCount(source: SourceEvidence) {
  const counts = new Set<number>();
  visit(source.structuredData, (node) => {
    if (node['@type'] !== 'MusicAlbum' && !(Array.isArray(node['@type']) && node['@type'].includes('MusicAlbum')))
      return;
    if ((node.url && node.url !== source.url) || (node['@id'] && node['@id'] !== source.url)) return;
    const count = Number(
      node.numTracks ??
        node.numberOfTracks ??
        String(node.description || '').match(/\b(\d+)\s+(?:songs|tracks|skladeb|skladby)\b/i)?.[1],
    );
    if (Number.isInteger(count) && count >= 2 && count <= 300) counts.add(count);
  });
  return counts.size === 1 ? [...counts][0] : null;
}
// Flattened album text can establish ordinals only for a complete, uniquely named,
// consecutively separated list agreeing with the source's declared track count.
export function verifiedSourceOrders(
  collection: string,
  def: any,
  rows: any[],
  sources: SourceEvidence[],
  facts: any[],
) {
  const verified = new Map<any, number>(),
    relations = Object.keys(def.columns).filter((field) => def.columns[field].type === 'list'),
    groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = JSON.stringify(relations.map((field) => row[field]));
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  for (const group of groups.values())
    for (const source of sources) {
      const count = albumCount(source);
      if (count === null || group.length !== count) continue;
      for (const field of anchors(def)) {
        const names = group.map((row) => normalizedSourceText(row[field] || '')),
          text = normalizedSourceText(source.text);
        if (
          names.some((name) => !name) ||
          new Set(names).size !== count ||
          group.some((row) => !citedName(source, facts, collection, field, row[field]))
        )
          continue;
        const positions = names.map((name) => text.indexOf(name));
        if (positions.some((position, index) => position < 0 || text.lastIndexOf(names[index]) !== position)) continue;
        const ordered = group
          .map((row, index) => ({ row, name: names[index], offset: positions[index] }))
          .sort((a, b) => a.offset - b.offset);
        const prefix = text.slice(Math.max(0, ordered[0].offset - 200), ordered[0].offset);
        if (!new RegExp('\\b' + count + '\\s+(?:songs|tracks|skladeb|skladby)\\b', 'i').test(prefix)) continue;
        const separators = ordered
          .slice(1)
          .map((entry, index) => text.slice(ordered[index].offset + ordered[index].name.length, entry.offset));
        if (
          !separators[0]?.trim() ||
          separators[0].length > 80 ||
          separators.some((separator) => separator !== separators[0])
        )
          continue;
        for (const [index, entry] of ordered.entries()) verified.set(entry.row, index + 1);
      }
    }
  return verified;
}
export function verifiedSourceNumber(
  fact: any,
  row: any,
  field: string,
  def: any,
  collection: string,
  source: SourceEvidence,
  facts: any[],
) {
  const number = Number(row[field]);
  if (
    !Number.isFinite(number) ||
    fact?.sourceId !== source.id ||
    fact.collection !== collection ||
    fact.field !== field ||
    fact.value !== row[field] ||
    typeof fact.quote !== 'string'
  )
    return false;
  const quote = normalizedSourceText(fact.quote),
    isOrder = orderField(field, def.columns[field]);
  if (!isOrder)
    return (
      sourceQuote(source, fact.quote) &&
      (quote.match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) || []).some((token) => Number(token) === number)
    );
  for (const anchor of anchors(def)) {
    if (!citedName(source, facts, collection, anchor, row[anchor])) continue;
    const name = normalizedSourceText(row[anchor]),
      escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (
      Number.isInteger(number) &&
      number > 0 &&
      sourceQuote(source, fact.quote) &&
      new RegExp('(?:^|[^\\d])' + number + '(?:[.)/:\\-]\\s*|\\s+)' + escaped + '(?:$|\\s|[.,;])').test(quote)
    )
      return true;
    let supported = false;
    visit(source.structuredData, (node) => {
      const names = [node.name, node.title, node.item?.name, node.item?.title];
      if (!names.some((value) => typeof value === 'string' && normalizedSourceText(value) === name)) return;
      for (const property of new Set([field, 'position', 'order', 'track_number', 'trackNumber'])) {
        if (
          node[property] === undefined ||
          !['number', 'string'].includes(typeof node[property]) ||
          Number(node[property]) !== number
        )
          continue;
        const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          match = quote.match(
            new RegExp('"' + escapedProperty + '"\\s*:\\s*("[^"\\n]+"|[-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)', 'i'),
          );
        if (match && Number(match[1].replace(/^"|"$/g, '')) === number) supported = true;
      }
    });
    if (supported) return true;
  }
  return false;
}
