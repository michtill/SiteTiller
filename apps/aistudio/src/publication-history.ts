import { recentConversation } from './memory.ts';
import { startingVersion, presentationState } from './step-changes.ts';
import { randomBytes } from 'node:crypto';
export function closePublishedHistory(config: any, events: any[]) {
  const all = config.requests || [],
    latest = (config.releases || []).findLast((r: any) => r.commit === config.publishedCommit);
  if (!config.publishedCommit) return { events, removed: 0 };
  const publishedTime = latest?.publishedAt ? Date.parse(latest.publishedAt) : Infinity;
  const matching = all.filter(
    (r: any) => r.commit === config.publishedCommit && (!r.createdAt || Date.parse(r.createdAt) <= publishedTime),
  );
  const published = config.publishedThrough ?? Math.max(0, ...matching.map((r: any) => r.sequence || 0));
  config.publishedThrough = published;
  // Steps through `closedThrough` have left the draft; a publication may keep its step and earlier ones.
  const through = config.closedThrough ?? published;
  config.requestSequence = Math.max(
    config.requestSequence || 0,
    config.reviewedThrough || 0,
    ...all.map((r: any) => r.sequence || 0),
  );
  const closed = all.filter((r: any) => r.sequence <= through),
    open = all.filter((r: any) => r.sequence > through);
  // "Remove previous steps": the removed steps are discarded, the AI does not remember them (documentation 4.9).
  const discard = config.discardClosedSteps === true;
  delete config.discardClosedSteps;
  if (discard) config.conversationMemory = [];
  else rememberClosed(config, closed, config.publishedCommit);
  for (const release of config.releases || []) {
    if (release.description === undefined) release.description = '';
    if (!release.summary) {
      const record = all.findLast((r: any) => r.commit === release.commit);
      release.summary = (record?.memory?.summary || record?.plan?.summary || '').slice(0, 1500);
    }
  }
  config.requests = open;
  startingVersion(config);
  const ids = new Set(open.map((r: any) => r.id));
  // The new first step stands for the publication, so its block goes with the removed steps.
  const kept = events.filter(
    (e) => ids.has(e.jobId) || (!discard && e.kind === 'publish' && e.at && Date.parse(e.at) > publishedTime),
  );
  return { events: kept, removed: closed.length };
}
// Closed steps leave the draft; the applied ones stay in the agents' conversation memory.
function rememberClosed(config: any, closed: any[], commit: string) {
  if (!closed.length) return;
  const context = recentConversation([...(config.conversationMemory || []), ...closed], commit);
  config.conversationMemory = context.turns
    .filter((t: any) => t.applied)
    .map((t: any) => ({
      id: t.id,
      sequence: t.sequence,
      prompt: t.request,
      resolvedRequest: t.resolvedRequest,
      status: t.status,
      scope: t.scope,
      commit: t.commit,
      restoredFrom: t.restoredFrom,
      memory: { summary: t.summary, changedFiles: t.changedFiles, deltas: t.deltas },
      imageResults: t.images,
    }));
}
// Saving a draft with "remove previous steps" (documentation 4.9): the saved step and the steps before it are
// replaced by a new first step "Saved draft <name>" and discarded; later steps stay. Without `saved` the steps
// before `step` leave and the agents remember them.
export function closeStepsBefore(config: any, events: any[], step: any, saved?: { id: string; name: string; commit: string }) {
  const all = config.requests || [],
    closed = all.filter((r: any) => r.sequence < step.sequence),
    open = all.filter((r: any) => r.sequence >= step.sequence);
  const from = step.createdAt ? Date.parse(step.createdAt) : NaN,
    ids = new Set(open.map((r: any) => r.id)),
    closedIds = new Set(closed.map((r: any) => r.id));
  // Earlier blocks without a step of their own (publications, reviews) leave with the steps.
  const kept = events.filter((e) =>
    ids.has(e.jobId)
      ? true
      : closedIds.has(e.jobId)
        ? false
        : Number.isFinite(from)
          ? !!e.at && Date.parse(e.at) >= from
          : e.stage !== 'published' && e.kind !== 'publish',
  );
  if (!saved && !closed.length && kept.length === events.length) return { events, removed: 0 };
  config.requestSequence = Math.max(config.requestSequence || 0, ...all.map((r: any) => r.sequence || 0));
  const savedStepId = step.id;
  if (saved) {
    // The saved step and the steps before it are replaced by a new first step "Saved draft <name>" and discarded.
    config.conversationMemory = [];
    firstStep(step, { savedDraftId: saved.id, savedDraftName: saved.name, restoredFrom: saved.commit });
    ids.delete(savedStepId);
    ids.add(step.id);
  } else rememberClosed(config, closed, step.commit);
  config.requests = open;
  startingVersion(config);
  if (saved) Object.assign(config, presentationState(config, step.commit));
  if (step.baseCommit) config.draftBaseCommit = step.baseCommit;
  if (config.presentationStepId && !ids.has(config.presentationStepId)) config.presentationStepId = null;
  return { events: saved ? kept.filter((e) => e.jobId !== savedStepId && !closedIds.has(e.jobId)) : kept, removed: closed.length };
}
// Which steps a finished publication closes. With "remove previous steps" (documentation 4.9) the published step
// and the steps before it are replaced by a new first step "Published version N" and discarded; without it the
// draft's steps do not change.
export function publicationClosing(config: any, commit: string, through: number, clearPrevious: boolean) {
  if (!clearPrevious) {
    config.closedThrough = config.closedThrough ?? config.publishedThrough ?? 0;
    return;
  }
  const step = (config.requests || []).findLast(
    (r: any) => r.commit === commit && ['ready', 'legacy'].includes(r.status) && r.sequence <= through,
  );
  config.closedThrough = step ? step.sequence - 1 : through;
  // The published step and the steps before it are replaced by a new first step "Published version N".
  const release = (config.releases || []).findLast((r: any) => r.commit === commit);
  if (step) {
    firstStep(step, {
      releaseId: release?.id || null,
      releaseVersion: release && !release.legacy ? release.number + (release.minor !== undefined ? '.' + release.minor : '') : '',
      releaseDescription: release?.description || '',
      restoredFrom: commit,
    });
    Object.assign(config, presentationState(config, commit));
  }
  config.discardClosedSteps = true;
}
// Turns a step into the new first step of the draft: same commit and place, a new identity without the AI work that
// made it (it stands for the saved draft or published version), always with its own preview.
function firstStep(step: any, origin: any) {
  for (const key of ['finalAnswer', 'plan', 'memory', 'progress', 'tests', 'imageResults', 'resolvedRequest', 'attachments', 'error', 'prompt', 'scope', 'models', 'checks', 'changedPaths'])
    delete step[key];
  Object.assign(step, origin, {
    id: randomBytes(8).toString('hex'),
    status: 'ready',
    firstStep: 'releaseId' in origin ? 'published' : 'saved',
    prompt: '',
    presentationChanged: true,
    changeKind: 'version',
  });
}
// Steps after the publication are unpublished work; kept earlier steps are not.
export function unpublishedRequests(config: any) {
  return (config.requests || []).filter(
    (r: any) => !(Number.isFinite(r.sequence) && r.sequence <= (config.publishedThrough || 0)),
  );
}
export function publicationSummary(requests: any[]) {
  return requests
    .filter((r) => r.status === 'ready' || r.status === 'legacy')
    .slice(-3)
    .map((r) => r.memory?.summary || r.plan?.summary || r.prompt || '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500);
}
export function visibleVersionHistory(history: any[], config: any) {
  const boundary = history.findIndex((h) => h.commit === (config.draftBaseCommit || config.publishedCommit)),
    published = new Set([
      ...(config.releases || []).map((r: any) => r.commit),
      ...(config.requests || []).filter((r: any) => ['ready', 'legacy'].includes(r.status)).map((r: any) => r.commit),
    ]);
  return history.filter((h, i) => i === 0 || published.has(h.commit) || boundary < 0 || i < boundary);
}
