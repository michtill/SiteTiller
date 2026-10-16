import { extname } from 'node:path';
import { Problem } from './store.ts';
// The largest file a folder accepts: its own limit from the structure, otherwise the default.
export const DEFAULT_FOLDER_MAX_MB = 20;
export function folderMaxMb(folder: { maxSizeMb?: number } | undefined) {
  return folder?.maxSizeMb ?? DEFAULT_FOLDER_MAX_MB;
}
export function folderMaxBytes(folder: { maxSizeMb?: number } | undefined) {
  return folderMaxMb(folder) * 1024 * 1024;
}
export function uploadName(type: string, name: string) {
  const images = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'],
    documents = ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.odt', '.ods', '.ppt', '.pptx'],
    allowed = type === 'img' ? images : type === 'other' ? documents : [...images, ...documents];
  if (
    typeof name !== 'string' ||
    name.length > 200 ||
    !name ||
    name !== name.normalize('NFC') ||
    !/^[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u.test(name) ||
    name.includes('..') ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    !allowed.includes(extname(name).toLowerCase())
  )
    throw new Problem(422, 'Tento název nebo typ souboru není ve složce povolen.');
  return name;
}
