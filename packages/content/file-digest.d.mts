import type { Stats } from 'node:fs';
export function fileDigest(path: string, info?: Stats): Promise<Buffer>;
