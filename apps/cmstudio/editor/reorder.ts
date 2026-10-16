export function reorder<T>(rows: T[], from: number, insertion: number) {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(insertion) ||
    from < 0 ||
    from >= rows.length ||
    insertion < 0 ||
    insertion > rows.length
  )
    return rows;
  const target = insertion > from ? insertion - 1 : insertion;
  if (target === from) return rows;
  const result = [...rows],
    item = result.splice(from, 1)[0];
  result.splice(target, 0, item);
  return result;
}
