import { translate, translateMessage } from '../../../packages/i18n/index.mjs';
export function sharedLanguage(): 'cs' | 'en' {
  return typeof document !== 'undefined' && document.documentElement.dataset.sharedLanguage === 'en' ? 'en' : 'cs';
}
// Interface text by key from the shared dictionary.
export function t(key: string, params: Record<string, unknown> = {}) {
  return translate(key, sharedLanguage(), params);
}
// Server messages and labels arrive as Czech text; they are shown in the interface language, unknown text verbatim.
export function localize(message: string) {
  return translateMessage(message, sharedLanguage());
}
export function uiLocale() {
  return sharedLanguage() === 'en' ? 'en-GB' : 'cs-CZ';
}
