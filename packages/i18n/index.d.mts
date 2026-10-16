export type Language = { name: string; dateLocale: string; messages: Record<string, string> };
export const languages: Record<string, Language>;
export const dictionaries: { cs: Record<string, string>; en: Record<string, string> };
export function normalizeLanguage(value: unknown, fallback?: string): string;
export function translate(key: string, language?: string, params?: Record<string, unknown>): string;
export function translateMessage(value: unknown, language?: string): string;
