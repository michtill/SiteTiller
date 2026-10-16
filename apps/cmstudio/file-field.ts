export function fileInFolder(value: string, folder: string) {
  const parts = value.replace(/^\/+/, '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes(':'))) return null;
  const index = parts.indexOf(folder);
  return index >= 0 && index < parts.length - 1 ? parts.slice(index).join('/') : null;
}
