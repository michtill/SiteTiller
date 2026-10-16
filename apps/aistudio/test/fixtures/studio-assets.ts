import { readFile } from 'node:fs/promises';
// The built AI Studio page (apps/aistudio/dist) for tests that serve it next to fixture APIs.
const dist = new URL('../../dist/', import.meta.url);
const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };
export async function studioAsset(pathname: string, language?: string): Promise<{ type: string; body: string } | null> {
  const name = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!(name === 'index.html' || name === 'theme.js' || /^assets\/[\w.-]+\.(js|css)$/.test(name))) return null;
  let body = await readFile(new URL(name, dist), 'utf8');
  if (name === 'index.html' && language)
    body = body.replace('<html lang="en">', '<html lang="' + language + '" data-shared-language="' + language + '">');
  return { type: types[name.split('.').pop()!], body };
}
