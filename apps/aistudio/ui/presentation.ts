import { t } from './i18n.ts';
// Groups the event log and edit requests into the steps shown in the conversation.
const phaseNames: Record<string, string> = {
  orchestrate: t('selecting_capabilities'),
  design: t('designing'),
  build: t('implementing'),
  test: t('checking'),
  verify: t('checking'),
  review: t('reviewing'),
};
function modelFor(events: any[], roles: any, role: string) {
  return [...events].reverse().find((e) => e.model)?.model || roles?.[role]?.model || 'Model';
}
export function compactProgress(
  events: any[],
  job: any = null,
  busy = false,
  roles: any = {},
  requests: any[] = [],
): any[] {
  const groups: any[] = [],
    byId = new Map<string, any>();
  let legacy: any = null;
  for (const [index, event] of events.entries()) {
    let group;
    if (event.jobId) {
      group = byId.get(event.jobId);
      if (!group) {
        group = { id: event.jobId, kind: event.kind || (event.stage === 'review' ? 'review' : 'edit'), events: [] };
        byId.set(group.id, group);
        groups.push(group);
      }
      legacy = null;
    } else {
      const solo = ['published', 'restored'].includes(event.stage),
        starts =
          (event.stage === 'design' || event.stage === 'review') &&
          (event.status === 'running' || (!event.status && event.model));
      if (solo || !legacy || (starts && event.stage === 'design')) {
        legacy = {
          id: 'legacy-' + (event.at || index) + '-' + event.stage,
          kind: solo ? event.stage : event.stage === 'review' ? 'review' : 'edit',
          events: [],
        };
        groups.push(legacy);
      }
      group = legacy;
    }
    group.events.push(event);
    if (!event.jobId && ['ready', 'failed', 'published', 'restored'].includes(event.stage)) legacy = null;
  }
  if (busy && job?.id && !byId.has(job.id)) groups.push({ id: job.id, kind: job.kind || 'edit', events: [] });
  const used = new Set();
  for (const group of groups) {
    const commit = group.events.findLast((e: any) => e.stage === 'ready' || e.stage === 'restored')?.commit;
    const request =
      requests.find((r) => r.id === group.id) ||
      (['edit', 'restore', 'restored'].includes(group.kind) && commit
        ? requests.findLast((r) => r.commit === commit)
        : null);
    if (request) {
      group.request = request;
      used.add(request.id);
      if (request.progress?.length) group.events = request.progress;
    }
  }
  const archived = requests
    .filter((r) => !used.has(r.id))
    .map((request) => ({
      id: request.id,
      kind: request.restoredFrom ? 'restore' : 'edit',
      request,
      events: [
        { stage: 'request', message: request.prompt, attachments: request.attachments },
        ...(request.plan
          ? [{ stage: 'design', status: 'completed', plan: request.plan, message: request.plan.summary }]
          : []),
        ...(request.finalAnswer
          ? [{ stage: 'final-answer', status: 'completed', message: request.finalAnswer, agentResponse: true }]
          : []),
        ...(request.tests
          ? [
              {
                stage: 'test',
                message: request.tests.analysis?.summary,
                checks: request.tests.analysis?.checks,
                warnings: request.tests.warnings || [],
                modelVerdict: request.tests.analysis?.modelVerdict,
              },
            ]
          : []),
        {
          stage: request.status === 'failed' ? 'failed' : request.status === 'running' ? 'design' : 'ready',
          commit: request.commit,
          message: request.error,
          agentResponse: !!request.errorFromAgent,
        },
      ],
    })) as any[];
  for (const group of archived) if (group.request.progress?.length) group.events = group.request.progress;
  const all = [...archived, ...groups];
  const dated = all.every((g) => g.createdAt || g.request?.createdAt || g.events[0]?.at);
  if (dated)
    all.sort((a, b) =>
      String(a.createdAt || a.request?.createdAt || a.events[0]?.at).localeCompare(
        String(b.createdAt || b.request?.createdAt || b.events[0]?.at),
      ),
    );
  const ordered = all.filter((g) => g.request).sort((a, b) => a.request.sequence - b.request.sequence);
  if (ordered.every((g) => Number.isFinite(g.request.sequence))) {
    let next = 0;
    for (let i = 0; i < all.length; i++) if (all[i].request) all[i] = ordered[next++];
  }
  const publication = all.findLastIndex((g) => g.events.some((e: any) => e.stage === 'published'));
  if (publication > 0) all.unshift(all.splice(publication, 1)[0]);
  return all.map((group) => {
    const last = group.events.at(-1),
      request = group.request,
      failed = last?.stage === 'failed' || (job?.id === group.id && ['failed', 'rejected'].includes(job.status)),
      done = ['ready', 'published', 'restored'].includes(last?.stage) || failed;
    const row: any = { key: group.id + '-status', running: !done, error: failed, events: group.events };
    if (group.kind === 'edit') {
      const phase =
        [...group.events]
          .reverse()
          .find((e: any) => ['orchestrate', 'design', 'build', 'test', 'verify'].includes(e.stage))?.stage || 'design';
      row.label = failed
        ? t('error')
        : done
          ? t('done')
          : phase === 'test' && !group.events.some((e: any) => e.stage === 'test' && e.model)
            ? t('technical_checks')
            : modelFor(
                group.events.filter((e: any) => e.stage === phase),
                request?.models || roles,
                (
                  {
                    orchestrate: 'primary',
                    design: 'ui',
                    build: 'primary',
                    test: 'verify',
                    verify: 'verify',
                  } as Record<string, string>
                )[phase] || phase,
              ) +
              ': ' +
              phaseNames[phase];
    } else if (group.kind === 'review')
      row.label = failed
        ? t('review_failed')
        : done
          ? t('review_complete')
          : modelFor(group.events, roles, 'verify') + ': ' + t('reviewing');
    else if (group.kind === 'publish')
      row.label = failed
        ? t('publishing_failed')
        : last?.stage === 'published'
          ? last.release
            ? t('version') +
              last.release.number +
              (last.release.minor !== undefined ? '.' + last.release.minor : '') +
              t('published_prefix')
            : t('published')
          : t('publishing_label');
    else {
      row.label = last?.stage === 'published' ? t('published') : t('version_loaded');
      row.running = false;
    }
    return {
      ...group,
      prompt: request?.firstStep ? '' : request?.prompt || group.events.find((e: any) => e.stage === 'request')?.message || '',
      // The first step that stands for a published version or saved draft (documentation 4.9).
      title:
        request?.firstStep === 'published'
          ? t('published_version_step', { version: request.releaseVersion || '' }).trim() +
            (request.releaseDescription ? ' – ' + request.releaseDescription : '')
          : request?.firstStep === 'saved'
            ? t('saved_draft_step', { name: request.savedDraftName || '' })
            : '',
      baseCommit: request?.baseCommit || group.events.find((e: any) => e.baseCommit)?.baseCommit,
      commit: request?.commit || group.events.findLast((e: any) => e.commit)?.commit,
      done: done && !failed,
      rows: [row],
    };
  });
}
// Completed discussion is archived only after an actual preview result arrives.
export function discussionBundles(entries: { id: string; result: boolean; collapsible: boolean }[]) {
  const bundles: { resultId: string; ids: string[] }[] = [];
  let pending: string[] = [];
  for (const entry of entries) {
    if (entry.result) {
      if (pending.length) bundles.push({ resultId: entry.id, ids: pending });
      pending = [];
    } else if (entry.collapsible) pending.push(entry.id);
    else pending = [];
  }
  return bundles;
}
export function humanError(message: unknown) {
  const text = String(message || '');
  if (/photo search or retrieval is not available/i.test(text) && /photograph/i.test(text))
    return t('real_photo_required');
  return text;
}
// Agent replies are shown verbatim; system messages in the interface language.
export function displayMessage(event: any, translate: (value: string) => string = (value) => value) {
  if (!event) return '';
  const fromAgent =
    event.agentResponse !== undefined
      ? event.agentResponse
      : event.stage === 'build' && event.status === 'completed' && !!event.model;
  return fromAgent
    ? String(event.message || '')
    : translate(event.stage === 'failed' ? humanError(event.message) : event.message || '');
}
export function releaseNumber(release: any) {
  return release.number + (release.minor !== undefined ? '.' + release.minor : '');
}
