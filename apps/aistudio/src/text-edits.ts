// Resolve exact edits in memory. The workflow validates paths, permissions and sizes before applying any result.
export function expandTextEdits(value: any, files: Record<string, string>, observed: Set<string>) {
  const operations = value.textEdits === undefined ? [] : value.textEdits;
  if (!Array.isArray(operations) || operations.length > 40) throw Error('Neplatné dílčí změny souborů.');
  const working = { ...files },
    changed = new Map<string, string>();
  const deleted = value.deleteFiles === undefined ? [] : value.deleteFiles;
  if (!Array.isArray(deleted)) throw Error('Neplatné odstranění souborů.');
  const full = value.files === undefined ? [] : value.files;
  if (!Array.isArray(full)) throw Error('Neplatná změna souborů.');
  const occupied = new Set(full.map((item: any) => item.path));
  for (const edit of operations) {
    if (
      !edit ||
      !['replace', 'extract'].includes(edit.kind) ||
      typeof edit.path !== 'string' ||
      !observed.has(edit.path) ||
      typeof working[edit.path] !== 'string' ||
      occupied.has(edit.path) ||
      deleted.includes(edit.path)
    )
      throw Error('Dílčí změna vyžaduje načtený soubor bez konfliktní změny.');
    const source = working[edit.path];
    let match: string, replacement: string;
    if (edit.kind === 'replace') {
      match = edit.before;
      replacement = edit.after;
    } else {
      if (
        typeof edit.start !== 'string' ||
        !edit.start ||
        typeof edit.end !== 'string' ||
        !edit.end ||
        typeof edit.target !== 'string' ||
        Object.hasOwn(working, edit.target) ||
        occupied.has(edit.target) ||
        deleted.includes(edit.target) ||
        typeof edit.replacement !== 'string'
      )
        throw Error('Neplatný přesun bloku do nového souboru.');
      const start = source.indexOf(edit.start),
        end = source.indexOf(edit.end, start + edit.start.length);
      if (
        start < 0 ||
        end < 0 ||
        source.indexOf(edit.start, start + 1) !== -1 ||
        source.indexOf(edit.end) !== end ||
        source.indexOf(edit.end, end + 1) !== -1
      )
        throw Error('Značky přesouvaného bloku nejsou jednoznačné.');
      match = source.slice(start, end + edit.end.length);
      replacement = edit.replacement;
      const content = source.slice(start + edit.start.length, end);
      working[edit.target] = content;
      changed.set(edit.target, content);
    }
    if (
      typeof match !== 'string' ||
      !match ||
      typeof replacement !== 'string' ||
      source.indexOf(match) < 0 ||
      source.indexOf(match, source.indexOf(match) + 1) !== -1
    )
      throw Error('Původní úsek změny musí přesně a jednoznačně odpovídat souboru.');
    working[edit.path] = source.replace(match, () => replacement);
    changed.set(edit.path, working[edit.path]);
  }
  return [...full, ...[...changed].map(([path, content]) => ({ path, content }))];
}
