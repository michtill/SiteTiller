import cs from './cs.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };
// One dictionary for the Shell, the Content editor and AI Studio: snake_case keys, {name} parameters.
// English is the fallback for a missing language or key; a further language registers its own entry here.
export const languages = {
  en: { name: 'English', dateLocale: 'en-GB', messages: en },
  cs: { name: 'Čeština', dateLocale: 'cs-CZ', messages: cs },
};
export const dictionaries = { cs, en };
export function normalizeLanguage(value, fallback = 'en') {
  return Object.hasOwn(languages, value) ? value : Object.hasOwn(languages, fallback) ? fallback : 'en';
}
const fill = (template, params) =>
  template.replace(/\{([a-z][a-z0-9_]*)\}/g, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token,
  );
export function translate(key, language = 'en', params = {}) {
  const code = String(key ?? ''),
    messages = languages[normalizeLanguage(language)].messages || {};
  return fill(Object.hasOwn(messages, code) ? messages[code] : Object.hasOwn(en, code) ? en[code] : code, params);
}
// Services answer with Czech (or older English) text; the interface finds the entry by that text and shows it
// in the user's language. Text that matches no entry (user content, AI replies) is returned unchanged.
const exact = new Map();
for (const source of [en, cs])
  for (const [key, text] of Object.entries(source)) if (!exact.has(text)) exact.set(text, key);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = [];
for (const source of [cs, en])
  for (const [key, text] of Object.entries(source)) {
    if (!/\{[a-z][a-z0-9_]*\}/.test(text) || text.replace(/\{[a-z][a-z0-9_]*\}/g, '').trim().length < 3) continue;
    const names = [];
    const pattern = new RegExp(
      '^' +
        text
          .split(/(\{[a-z][a-z0-9_]*\})/)
          .map((part) => {
            const m = part.match(/^\{([a-z][a-z0-9_]*)\}$/);
            if (m) {
              names.push(m[1]);
              return '([\\s\\S]*?)';
            }
            return escape(part);
          })
          .join('') +
        '$',
    );
    templates.push({ key, pattern, names, weight: text.replace(/\{[a-z][a-z0-9_]*\}/g, '').length });
  }
templates.sort((a, b) => b.weight - a.weight);
const prefixes = [...exact.keys()]
  .filter((text) => !text.includes('{') && text.length > 3)
  .sort((a, b) => b.length - a.length);
export function translateMessage(value, language = 'en') {
  const text = String(value ?? '');
  if (Object.hasOwn(en, text)) return translate(text, language);
  const key = exact.get(text);
  if (key) return translate(key, language);
  const trimmed = text.trim(),
    trimmedKey = exact.get(trimmed);
  if (trimmedKey) return text.replace(trimmed, () => translate(trimmedKey, language));
  for (const { key, pattern, names } of templates) {
    const match = text.match(pattern);
    if (match)
      return translate(key, language, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
  }
  for (const prefix of prefixes)
    if (text.startsWith(prefix + ' ')) return translate(exact.get(prefix), language) + text.slice(prefix.length);
  return text;
}
