import { providerIds, imageModelProvider } from '../providers/index.mjs';
// Recommendation sets (documentation 4.6): named sets (Performance team, Economy team…), each a whole team with the
// four text roles and both image tools. A release ships recommended-sets.json; with a recommended team the AI Studio
// may also read the current file from this one fixed address (6.2). The advice lives in its own repository, one folder
// per topic and one file per version of its shape (models/v2.json), so a release of the application never overwrites
// it and older instances keep reading their file (1.0.4 reads models/v1.json and images/v1.json).
export const recommendedSetsUrl = 'https://raw.githubusercontent.com/michtill/SiteTiller-advice/main/models/v2.json';
export const recommendedLimit = 64 * 1024;
export const roles = ['primary', 'ui', 'verify', 'escalation'];
const tools = ['precise', 'fast'];
const efforts = ['auto', 'low', 'medium', 'high'];
const exactKeys = (value, keys, optional = []) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  keys.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => keys.includes(k) || optional.includes(k));
const list = (value, item) => Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every(item);
const text = (value, max) =>
  exactKeys(value, ['cs', 'en']) &&
  ['cs', 'en'].every((l) => typeof value[l] === 'string' && value[l].trim() && value[l].length <= max);
const roleItem = (item) =>
  exactKeys(item, ['provider', 'model'], ['effort']) &&
  providerIds.includes(item.provider) &&
  typeof item.model === 'string' &&
  /^[a-zA-Z0-9:._-]{1,160}$/.test(item.model) &&
  (item.effort === undefined || efforts.includes(item.effort));
const imageItem = (item) =>
  exactKeys(item, ['provider', 'model']) &&
  typeof item.model === 'string' &&
  imageModelProvider(item.model) === item.provider;
// One set: a name and a sentence for people, the four roles and both image tools.
function validSet(set) {
  return (
    exactKeys(set, ['name', 'description', 'roles', 'images']) &&
    text(set.name, 40) &&
    text(set.description, 200) &&
    exactKeys(set.roles, roles) &&
    roles.every((role) => list(set.roles[role], roleItem)) &&
    exactKeys(set.images, tools) &&
    tools.every((tool) => list(set.images[tool], imageItem))
  );
}
// The file is data only: anything outside this shape refuses the whole file. The revision (1, 2, 3…) grows with every
// change of the content and tells which file is newer; the date is the real day of publication, for people.
export function validRecommendationSets(value) {
  if (!exactKeys(value, ['version', 'revision', 'date', 'default', 'sets']) || value.version !== 2) return false;
  if (!Number.isInteger(value.revision) || value.revision < 1 || value.revision > 1000000) return false;
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || isNaN(Date.parse(value.date)))
    return false;
  if (!value.sets || typeof value.sets !== 'object' || Array.isArray(value.sets)) return false;
  const ids = Object.keys(value.sets);
  return (
    ids.length >= 1 &&
    ids.length <= 10 &&
    ids.every((id) => /^[a-z][a-z0-9-]{1,30}$/.test(id) && validSet(value.sets[id])) &&
    typeof value.default === 'string' &&
    Object.hasOwn(value.sets, value.default)
  );
}
export function parseRecommendationSets(text) {
  if (typeof text !== 'string' || text.length > recommendedLimit) return null;
  try {
    const value = JSON.parse(text);
    return validRecommendationSets(value) ? value : null;
  } catch {
    return null;
  }
}
// Each role of a set: the first recommended model the user has a key for and the provider's catalog offers;
// otherwise the role stays as it was.
export function recommendedTeam(set, models, keys, current) {
  const team = structuredClone(current);
  for (const role of roles) {
    const pick = set.roles[role].find(
      (item) =>
        keys[item.provider] && models.some((m) => m.provider === item.provider && m.id === item.model && m.usable),
    );
    if (pick) team[role] = { provider: pick.provider, model: pick.model, reasoningEffort: pick.effort || 'auto' };
  }
  return team;
}
// Each image tool of a set: the first recommended model the user has a key for and the provider's catalog lists;
// otherwise the tool stays as it was.
export function recommendedImageTools(set, models, keys, current) {
  const result = { ...current };
  for (const tool of tools) {
    const pick = set.images[tool].find(
      (item) => keys[item.provider] && models.some((m) => m.provider === item.provider && m.id === item.model),
    );
    if (pick) result[tool] = pick.model;
  }
  return result;
}
