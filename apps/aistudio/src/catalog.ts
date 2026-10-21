import { roleNames, type Team, type Role } from './team.ts';
import type { Provider } from './core.ts';
import { providerIds, providerName } from '../../../packages/providers/index.mjs';
export type ListedModel = { provider: Provider; id: string; name: string; usable: boolean };
export function usableModel(provider: Provider, id: string, methods?: string[]) {
  if (provider === 'anthropic') return id.startsWith('claude-');
  if (provider === 'gemini')
    return (
      id.startsWith('gemini-') &&
      (!methods || methods.includes('generateContent')) &&
      !/(embedding|tts|live|image|aqa|audio|robotics|computer-use)/i.test(id)
    );
  return (
    /^(gpt-|chatgpt-|o[1-9](?:-|$)|ft:(?:gpt-|o[1-9]))/.test(id) &&
    !/(audio|realtime|transcrib|tts|image|embedding|moderation|search|instruct)/i.test(id)
  );
}
export async function catalog(keys: Record<Provider, string>, fetcher = fetch) {
  const results = await Promise.all(
    (providerIds as Provider[]).map(async (provider) => {
      if (!keys[provider])
        return {
          provider,
          models: [] as ListedModel[],
          error: 'API klíč není nastavený.',
          errorKind: 'missing_key',
          httpStatus: null,
        };
      try {
        const models: ListedModel[] = [];
        let after = '';
        const seen = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const url =
            provider === 'openai'
              ? 'https://api.openai.com/v1/models'
              : provider === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' +
                  (after ? '&pageToken=' + encodeURIComponent(after) : '')
                : 'https://api.anthropic.com/v1/models?limit=1000' +
                  (after ? '&after_id=' + encodeURIComponent(after) : '');
          // The Gemini key goes in its header, never in the address.
          const response = await fetcher(url, {
            headers:
              provider === 'openai'
                ? { Authorization: 'Bearer ' + keys[provider] }
                : provider === 'gemini'
                  ? { 'x-goog-api-key': keys[provider] }
                  : { 'x-api-key': keys[provider], 'anthropic-version': '2023-06-01' },
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) {
            let code = '';
            if (response.status === 429)
              try {
                const body: any = await response.json();
                if (body.error?.code === 'insufficient_quota' || body.error?.type === 'insufficient_quota')
                  code = 'insufficient_quota';
              } catch {}
            throw Object.assign(Error('HTTP ' + response.status), { httpStatus: response.status, providerCode: code });
          }
          const body: any = await response.json();
          if (provider === 'gemini') {
            if (!Array.isArray(body.models)) throw new Error('invalid');
            for (const item of body.models) {
              const id = typeof item.name === 'string' ? item.name.replace(/^models\//, '') : '';
              if (!id || seen.has(id)) continue;
              seen.add(id);
              const name = typeof item.displayName === 'string' ? item.displayName : id;
              models.push({
                provider,
                id,
                // Preview models say so (documentation 4.6).
                name: /preview|exp/i.test(id) && !/preview/i.test(name) ? name + ' (preview)' : name,
                usable: usableModel(provider, id, item.supportedGenerationMethods),
              });
            }
            if (!body.nextPageToken) return { provider, models, error: null, errorKind: null, httpStatus: null };
            if (after === body.nextPageToken) throw new Error('pagination');
            after = body.nextPageToken;
            continue;
          }
          if (!Array.isArray(body.data)) throw new Error('invalid');
          for (const item of body.data)
            if (typeof item.id === 'string' && !seen.has(item.id)) {
              seen.add(item.id);
              models.push({
                provider,
                id: item.id,
                name: typeof item.display_name === 'string' ? item.display_name : item.id,
                usable: usableModel(provider, item.id),
              });
            }
          if (provider === 'openai' || !body.has_more)
            return { provider, models, error: null, errorKind: null, httpStatus: null };
          if (!body.last_id || after === body.last_id) throw new Error('pagination');
          after = body.last_id;
        }
        throw new Error('pagination');
      } catch (e: any) {
        const httpStatus = Number.isInteger(e.httpStatus) ? e.httpStatus : null;
        let errorKind = 'network',
          detail = 'síťové spojení se nezdařilo';
        if (e.code === 'ERR_SITETILLER_NETWORK_BLOCKED') {
          errorKind = 'blocked_network';
          detail =
            e.networkMode === 'offline'
              ? 'připojení poskytovatelů je vypnuté (offline)'
              : 'požadavek je blokovaný síťovým režimem instance';
        } else if (httpStatus === 401) {
          errorKind = 'authentication';
          detail = 'klíč nebyl přijat (HTTP 401)';
        } else if (httpStatus === 403 || httpStatus === 404) {
          errorKind = 'access';
          detail = 'chybí přístup k API nebo modelům (HTTP ' + httpStatus + ')';
        } else if (httpStatus === 429) {
          errorKind = e.providerCode === 'insufficient_quota' ? 'quota' : 'rate_limit';
          detail = errorKind === 'quota' ? 'vyčerpaná API kvóta (HTTP 429)' : 'omezení počtu požadavků (HTTP 429)';
        } else if (httpStatus) {
          errorKind = 'provider';
          detail = 'chyba poskytovatele (HTTP ' + httpStatus + ')';
        } else if (e.message === 'invalid' || e.message === 'pagination') {
          errorKind = 'invalid_response';
          detail = 'neplatný seznam modelů od poskytovatele';
        }
        return {
          provider,
          models: [] as ListedModel[],
          error:
            (provider === 'anthropic' ? 'Claude / Anthropic' : providerName(provider)) +
            ': ' +
            detail +
            '. Nelze ověřit dostupnost modelů.',
          errorKind,
          httpStatus,
          detail,
        };
      }
    }),
  );
  return {
    models: results
      .flatMap((r) => r.models)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
    providers: results.map(({ provider, error, models, errorKind, httpStatus, detail }: any) => ({
      provider,
      error,
      count: models.length,
      errorKind,
      httpStatus,
      detail: detail || null,
    })),
    checkedAt: new Date().toISOString(),
  };
}
export function unavailable(
  team: Team,
  list: Awaited<ReturnType<typeof catalog>>,
  roles: Role[] = Object.keys(roleNames) as Role[],
) {
  return roles.flatMap((role) => {
    const selected = team[role];
    const provider = list.providers.find((p) => p.provider === selected.provider);
    if (provider?.error) return [roleNames[role] + ' · ' + selected.model + ': ' + provider.error];
    if (!list.models.some((m) => m.provider === selected.provider && m.id === selected.model && m.usable))
      return [roleNames[role] + ' · ' + selected.model + ': model není dostupný pro tuto roli.'];
    return [];
  });
}
