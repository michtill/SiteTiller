import { publicUrl } from './web-import.ts';
// Settings store a deployment address; importing an arbitrary URL still uses publicUrl.
export function settingsSiteUrl(
  value: string,
  configured = process.env.SITETILLER_SITE_URL || process.env.SITETILLER_SITE_ORIGIN || '',
) {
  const text = value.trim();
  if (!text) return '';
  const candidate = new URL(text);
  let trusted: URL | undefined;
  try {
    trusted = new URL(configured);
  } catch {}
  if (
    trusted &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(trusted.hostname) &&
    ['http:', 'https:'].includes(trusted.protocol) &&
    candidate.origin === trusted.origin &&
    !candidate.username &&
    !candidate.password
  ) {
    candidate.hash = '';
    return candidate.href;
  }
  return publicUrl(text).href;
}
