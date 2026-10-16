import { languages, translate, translateMessage } from '../../../packages/i18n/index.mjs';
// AI Studio language: the shared setting from the Shell, else this browser's choice, else the page language;
// English when none of them names a registered language.
export const defaultLocale = 'en';
export function normalizeLocale(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(languages, value) ? value : defaultLocale;
}
let saved: string | null = null;
try {
  saved = globalThis.localStorage?.getItem('sitetiller-language');
} catch {}
export const locale = normalizeLocale(
  globalThis.document?.documentElement.dataset.sharedLanguage || saved || globalThis.document?.documentElement.lang,
);
export const dateLocale = languages[locale].dateLocale || locale;
export function t(key: string, params: Record<string, unknown> = {}, language = locale) {
  return translate(key, language, params);
}
// Service messages (Czech or older English text) in the interface language; other text stays verbatim.
export function tm(value: unknown, language = locale) {
  return translateMessage(value, language);
}
