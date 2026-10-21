import { providerIds } from '../providers/index.mjs';
// Recommended models (documentation 4.6): a release ships recommended.json; with "Team automatically by the
// recommendation" on, the AI Studio may also read the current file from this one fixed address (6.2).
export const recommendedUrl =
  'https://raw.githubusercontent.com/michtill/SiteTiller/main/packages/models/recommended.json';
export const recommendedLimit = 64 * 1024;
const roles = ['primary', 'ui', 'verify', 'escalation'];
const efforts = ['auto', 'low', 'medium', 'high'];
const exactKeys = (value, keys, optional = []) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  keys.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => keys.includes(k) || optional.includes(k));
// The file is data only: anything outside this shape refuses the whole file.
export function validRecommendation(value) {
  if (!exactKeys(value, ['version', 'date', 'roles']) || value.version !== 1) return false;
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || isNaN(Date.parse(value.date)))
    return false;
  if (!exactKeys(value.roles, roles)) return false;
  return roles.every(
    (role) =>
      Array.isArray(value.roles[role]) &&
      value.roles[role].length >= 1 &&
      value.roles[role].length <= 20 &&
      value.roles[role].every(
        (item) =>
          exactKeys(item, ['provider', 'model'], ['effort']) &&
          providerIds.includes(item.provider) &&
          typeof item.model === 'string' &&
          /^[a-zA-Z0-9:._-]{1,160}$/.test(item.model) &&
          (item.effort === undefined || efforts.includes(item.effort)),
      ),
  );
}
export function parseRecommendation(text) {
  if (typeof text !== 'string' || text.length > recommendedLimit) return null;
  try {
    const value = JSON.parse(text);
    return validRecommendation(value) ? value : null;
  } catch {
    return null;
  }
}
// Each role: the first recommended model the user has a key for and the provider's catalog offers; otherwise the
// role stays as it was.
export function recommendedTeam(recommendation, models, keys, current) {
  const team = structuredClone(current);
  for (const role of roles) {
    const pick = recommendation.roles[role].find(
      (item) =>
        keys[item.provider] && models.some((m) => m.provider === item.provider && m.id === item.model && m.usable),
    );
    if (pick) team[role] = { provider: pick.provider, model: pick.model, reasoningEffort: pick.effort || 'auto' };
  }
  return team;
}
