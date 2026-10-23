import { recommendedTeam, recommendedImageTools } from '../../../packages/models/index.mjs';
// AI teams (documentation 2.4, 4.2, 4.6): recommended teams, one for each recommendation set, and named custom teams.
// All are valid; one is the default team, which is mirrored in config.roles and config.imageModels, and every request
// may choose another one. A recommended team is computed from its set, the keys and the catalog; a custom team is
// stored as it was saved.
export type TeamName = string | { cs: string; en: string };
export type Team = {
  id: string;
  kind: 'recommended' | 'custom';
  name: TeamName;
  description?: { cs: string; en: string };
  roles: any;
  imageModels: any;
};
const clone = <T>(value: T): T => structuredClone(value);
// The team of an older version becomes the custom team "Vlastní tým"; who used the recommended team keeps the
// default set as the default team. Nothing is lost: the old fields stay readable in config.json.
export function migrateTeams(config: any, recommendation: any) {
  if (Array.isArray(config.teams)) return false;
  const own = config.autoTeam && config.customTeam ? config.customTeam : config;
  config.teams = [{ id: 'custom-1', name: 'Vlastní tým', roles: clone(own.roles), imageModels: clone(own.imageModels) }];
  config.defaultTeam = config.autoTeam ? recommendation.default : 'custom-1';
  config.recommendedTeams = {};
  return true;
}
export function customTeam(config: any, id: string) {
  return (config.teams || []).find((team: any) => team.id === id) || null;
}
export function teamOf(config: any, recommendation: any, id: string): Team | null {
  const custom = customTeam(config, id);
  if (custom) return { id, kind: 'custom', ...clone(custom) };
  const set = recommendation.sets[id];
  if (!set) return null;
  const resolved = config.recommendedTeams?.[id] || config;
  return {
    id,
    kind: 'recommended',
    name: set.name,
    description: set.description,
    roles: clone(resolved.roles),
    imageModels: clone(resolved.imageModels),
  };
}
export function teamList(config: any, recommendation: any) {
  return [...Object.keys(recommendation.sets), ...(config.teams || []).map((team: any) => team.id)]
    .map((id) => teamOf(config, recommendation, id))
    .filter(Boolean) as Team[];
}
// A default team whose set has disappeared from the recommendation gives way to the default set, and the page says so.
export function ensureDefault(config: any, recommendation: any) {
  if (teamOf(config, recommendation, config.defaultTeam)) return false;
  config.teamNotice = { missing: config.defaultTeamName || config.defaultTeam };
  config.defaultTeam = recommendation.default;
  return true;
}
export function syncDefault(config: any, recommendation: any) {
  ensureDefault(config, recommendation);
  const team = teamOf(config, recommendation, config.defaultTeam)!;
  config.roles = clone(team.roles);
  config.imageModels = clone(team.imageModels);
  config.defaultTeamName = team.name;
}
// Every recommended team follows its set: each role and image tool gets the first recommended model with a key and in
// the catalog; otherwise it stays as it was. Returns whether anything changed.
export function applyRecommended(config: any, recommendation: any, models: any[], keys: Record<string, string>) {
  const before = JSON.stringify([config.recommendedTeams, config.roles, config.imageModels, config.defaultTeam]);
  config.recommendedTeams = Object.fromEntries(
    Object.entries(recommendation.sets).map(([id, set]: [string, any]) => {
      const previous = config.recommendedTeams?.[id] || config;
      return [
        id,
        {
          roles: recommendedTeam(set, models, keys, previous.roles),
          imageModels: recommendedImageTools(set, models, keys, previous.imageModels),
        },
      ];
    }),
  );
  syncDefault(config, recommendation);
  return before !== JSON.stringify([config.recommendedTeams, config.roles, config.imageModels, config.defaultTeam]);
}
// A new custom team is a copy of the shown team, named "Vlastní tým N" with the first free number.
export function createTeam(config: any, from: Team) {
  const used = new Set((config.teams || []).map((team: any) => team.name));
  let n = (config.teams || []).length + 1;
  while (used.has('Vlastní tým ' + n)) n++;
  let id = 'custom-' + n;
  while (customTeam(config, id)) id = 'custom-' + ++n;
  const team = { id, name: 'Vlastní tým ' + n, roles: clone(from.roles), imageModels: clone(from.imageModels) };
  config.teams = [...(config.teams || []), team];
  return team;
}
export function validTeamName(value: unknown) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40 && !/[<>]/.test(value);
}
