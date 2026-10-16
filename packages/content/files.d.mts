export function atomicWrite(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
export function linkOrCopy(source: string, target: string): Promise<void>;
export function linkTree(source: string, target: string): Promise<void>;
export function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  options?: { stale?: number; wait?: number },
): Promise<T>;
export function pruneNewest(
  directory: string,
  options: { keep: number; protect?: (string | undefined | null)[]; filter?: (name: string) => boolean },
): Promise<string[]>;
