import { readFileSync } from 'node:fs';
// The application has one version, kept in the repository root package.json.
export const appVersion: string = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
