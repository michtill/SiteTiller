import { reactive, nextTick } from 'vue';
import { t, tm } from './i18n.ts';
// The application state of AI Studio and everything that changes it. Components render this state; the
// preview iframes are the one part handled imperatively (see preview.ts), because they must stay alive.
export const APP_BASE = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
export type Selection = {
  kind: 'step' | 'draft' | 'release' | 'saved';
  id: string | null;
  commit: string;
  historical: boolean;
  cmsMode?: string;
  message?: string;
  savedUrl?: string;
};
export const s = reactive({
  session: null as any,
  current: null as any,
  ready: false,
  loadingText: '',
  notice: '',
  editorName: 'SiteTiller',
  cmsPreviewMode: 'published',
  prompt: '',
  attachments: [] as any[],
  submitting: false,
  uploading: false,
  restoring: false,
  workspaceTab: 'edits' as 'edits' | 'drafts' | 'history',
  displayedSelection: null as Selection | null,
  pendingSelection: null as Selection | null,
  previewPending: false,
  previewFollowCurrent: true,
  previewPendingKey: null as string | null,
  previewFailedKey: null as string | null,
  projectTitle: '',
  projectTitleHint: '',
  openPreviewHref: '',
  historicalPreview: false,
  mobile: false,
  settingsOpen: false,
  modelCatalog: null as any,
  availabilityIssues: [] as string[],
  modelAlerts: [] as string[],
  publishProgress: '',
});
// Inside the Shell frame the studio stays alive; switching studios and leaving go through the frame.
export const framed = (() => {
  try {
    return window.parent !== window && window.parent.location.origin === location.origin;
  } catch {
    return false;
  }
})();
let studioVisible = true;
export function navigateStudio(href: string) {
  if (framed) window.parent.postMessage({ type: 'sitetiller-navigate', href }, location.origin);
  else location.assign(href);
}
export function reportLocation() {
  if (framed)
    window.parent.postMessage(
      { type: 'sitetiller-location', href: location.pathname + location.search + location.hash },
      location.origin,
    );
}
function reportTitle() {
  if (framed && studioVisible)
    window.parent.postMessage({ type: 'sitetiller-title', title: document.title }, location.origin);
}
const openSettingsRequests: (() => void)[] = [];
export function onOpenSettings(handler: () => void) {
  openSettingsRequests.push(handler);
}
window.addEventListener('message', (event) => {
  if (!framed || event.source !== window.parent || event.origin !== location.origin) return;
  const data = event.data || {};
  if (data.type === 'sitetiller-visibility') {
    studioVisible = !!data.visible;
    if (studioVisible) {
      reportLocation();
      reportTitle();
      if (s.current) void refresh().catch(() => {});
    } else clearTimeout(timer);
  } else if (
    data.type === 'sitetiller-open' &&
    typeof data.href === 'string' &&
    new URL(data.href, location.href).searchParams.get('settings') === 'ai' &&
    s.current
  )
    for (const handler of openSettingsRequests) handler();
});
export function sharedSettingsHref() {
  return /^\/site(?:\/|$)/.test(location.pathname)
    ? '/settings?returnTo=' + encodeURIComponent(location.pathname + location.search + location.hash)
    : '/settings?returnTo=%2Fsite%2F';
}

// Sign-in belongs to the shared Shell; an expired session returns there.
export function toShellLogin() {
  clearTimeout(timer);
  const top = framed ? window.top!.location : location;
  top.assign('/login?next=' + encodeURIComponent(top.pathname + top.search + top.hash));
}
export async function api(path: string, data?: unknown, signal?: AbortSignal) {
  const response = await fetch(APP_BASE + '/api/' + path, {
    signal,
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
    toShellLogin();
    throw new Error(t('sign_in'));
  }
  const value = await response.json();
  if (!response.ok) throw new Error(tm(value.error) || t('the_request_failed'));
  return value;
}
let noticeTimer: any = null;
export function notice(text: string) {
  s.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    s.notice = '';
  }, 8000);
}

// Every refresh schedules the next one: 2.5 s while work is in progress, 10 s when idle, none while hidden.
let timer: any = null,
  stateEtag = '';
function studioActive() {
  return !document.hidden && studioVisible;
}
export function schedulePoll() {
  clearTimeout(timer);
  if (!s.current || !studioActive()) return;
  const working = s.current.busy || s.submitting || s.uploading || s.previewPending;
  timer = setTimeout(
    () => {
      void refresh().catch(() => {});
    },
    working ? 2500 : 10000,
  );
}
document.addEventListener('visibilitychange', () => {
  if (studioActive()) void refresh().catch(() => {});
  else clearTimeout(timer);
});
// An unchanged state answers 304 and the studio keeps its copy.
async function fetchState() {
  const response = await fetch(APP_BASE + '/api/state', {
    headers: stateEtag && s.current ? { 'x-state-etag': stateEtag } : {},
  });
  if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
    toShellLogin();
    throw new Error(t('sign_in'));
  }
  if (response.status === 304) return s.current;
  const value = await response.json();
  if (!response.ok) throw new Error(tm(value.error) || t('the_request_failed'));
  stateEtag = response.headers.get('x-state-etag') || '';
  return value;
}
export async function refresh(initialState?: any) {
  try {
    return await refreshNow(initialState);
  } finally {
    schedulePoll();
  }
}
const refreshListeners: (() => void)[] = [];
export function onRefresh(handler: () => void) {
  refreshListeners.push(handler);
}
async function refreshNow(initialState?: any) {
  s.current = initialState || (await fetchState());
  const current = s.current;
  if (current.editorName) {
    s.editorName = current.editorName;
    document.title = current.editorName + ' — AI Studio';
    reportTitle();
  }
  const sources = current.cmsPreviewSources || {};
  if (!sources[s.cmsPreviewMode]) s.cmsPreviewMode = sources.published ? 'published' : 'unpublished';
  if (current.job?.kind === 'publish' && current.job.status === 'running') {
    const progress = [...(current.events || [])]
      .reverse()
      .find(
        (event: any) =>
          event.kind === 'publish' && event.jobId === current.job.id && event.status === 'running' && event.message,
      );
    if (progress) s.publishProgress = progress.message;
  }
  renderPreview();
  for (const handler of refreshListeners) handler();
}
export async function start() {
  s.session = await api('session');
  if (!s.session.authenticated) {
    toShellLogin();
    return;
  }
  s.loadingText = t('loading_draft_and_content');
  const [contentStatus, initialState] = await Promise.all([api('design-content-status'), api('state')]);
  s.cmsPreviewMode = contentStatus.unpublished ? 'unpublished' : 'published';
  await refresh(initialState);
  s.loadingText = '';
  s.ready = true;
  void checkModels(true).catch((e) => notice(e.message));
  reportLocation();
  schedulePoll();
}

// Preview selection: what the preview shows (displayed), what is loading (pending), and the derived values.
export function readySteps() {
  return (s.current?.requests || []).filter((r: any) => ['ready', 'legacy'].includes(r.status) && r.commit);
}
export function currentPreviewSelection(): Selection {
  const current = s.current,
    latest = readySteps().at(-1),
    release = !current.hasUnpublishedWork && !current.contentChanged ? current.releases?.at(-1) : null;
  return release
    ? {
        kind: 'release',
        id: release.id,
        commit: release.commit,
        historical: true,
        message: release.description || release.summary,
      }
    : {
        kind: latest ? 'step' : 'draft',
        id: latest?.id || null,
        commit: current.head,
        historical: false,
        cmsMode: s.cmsPreviewMode,
        message: latest?.prompt,
      };
}
export function selectionKey(selection: Partial<Selection>) {
  return JSON.stringify([selection.kind, selection.id, selection.commit, selection.historical, selection.cmsMode]);
}
export function viewedCommit() {
  return s.displayedSelection?.commit || s.current?.head;
}
export function selectedPreview() {
  const d = s.displayedSelection;
  return d && d.historical && d.kind !== 'saved' ? d.commit : null;
}
export function selectedReleaseId() {
  return s.displayedSelection?.kind === 'release' ? s.displayedSelection.id : null;
}
export function selectedSavedDraftId() {
  return s.displayedSelection?.kind === 'saved' ? s.displayedSelection.id : null;
}
export function selectedStepId() {
  return s.displayedSelection?.kind === 'step' ? s.displayedSelection.id : null;
}
export function displayedPresentationCommit() {
  const d = s.displayedSelection,
    current = s.current;
  return d && d.commit !== current.head ? d.commit : selectedPreview() || current?.presentationHead || current?.head;
}
export function historicalContent() {
  const d = s.displayedSelection;
  return !!d && (d.historical || d.commit !== s.current.head);
}
export function selectionUrl(selection: Selection) {
  if (selection.kind === 'saved') return new URL(selection.savedUrl!, location.href);
  const current = s.current,
    url = new URL(current.previewUrl, location.href);
  url.pathname =
    url.pathname.replace(/\/?$/, '/') +
    (selection.historical
      ? 'snapshots/'
      : current.cmsPreviewSources?.[selection.cmsMode!]
        ? 'sources/' + selection.cmsMode + '/'
        : '') +
    'versions/' +
    selection.commit +
    '/';
  return url;
}
// Which selector (step eye, release card, saved draft) is pressed: the loading choice wins over the shown one.
export function selectorState(kind: string, id: string | null, commit?: string) {
  const pending = s.pendingSelection,
    visual = pending || s.displayedSelection;
  const busy = !!pending && pending.kind === kind && pending.id === id;
  const active =
    !!visual &&
    visual.kind === kind &&
    (visual.id === id || (!pending && kind === 'step' && commit === displayedPresentationCommit()));
  return { busy, active };
}

let previewModule: any = null;
export function usePreviewModule(module: any) {
  previewModule = module;
}
export function selectPreviewTarget(selection: Selection, force = false, follow = false): Promise<boolean> {
  return previewModule.selectPreviewTarget(selection, force, follow);
}
export function renderPreview() {
  if (!s.current) return;
  if (s.previewFollowCurrent) {
    const target = currentPreviewSelection(),
      key = selectionKey(target);
    if (key !== selectionKey(s.displayedSelection || {}) && key !== s.previewPendingKey && key !== s.previewFailedKey) {
      void selectPreviewTarget(target, false, true);
    }
  }
}
export function resetPreviewSelection() {
  s.previewFollowCurrent = true;
  s.previewFailedKey = null;
  if (s.current) renderPreview();
}
export async function selectDraftStep(step: any) {
  const latest = readySteps().at(-1),
    historical = step.id !== latest?.id || step.commit !== s.current.head;
  return selectPreviewTarget(
    {
      kind: 'step',
      id: step.id,
      commit: step.commit,
      historical,
      cmsMode: historical ? undefined : s.cmsPreviewMode,
      message: step.prompt,
    },
    false,
    !historical,
  );
}
export function selectSavedDraft(draft: any) {
  if (!draft) return;
  return selectPreviewTarget({
    kind: 'saved',
    id: draft.id,
    commit: draft.commit,
    historical: true,
    message: draft.name,
  });
}
// The eye of a step or publication in the conversation.
export function eyeTarget(item: { commit: string; stepId?: string; releaseId?: string; message?: string }) {
  const current = s.current,
    currentStep = !item.releaseId && item.commit === (current.presentationHead || current.head);
  if (!item.releaseId && currentStep && readySteps().at(-1)?.presentationChanged === false) {
    resetPreviewSelection();
    return;
  }
  if (item.releaseId) {
    void selectPreviewTarget({
      kind: 'release',
      id: item.releaseId,
      commit: item.commit,
      historical: true,
      message: item.message,
    });
    return;
  }
  const step =
    (current.requests || []).find((r: any) => r.id === item.stepId) ||
    (current.requests || []).findLast((r: any) => r.commit === item.commit && r.presentationChanged !== false);
  if (step) void selectDraftStep(step);
  else
    void selectPreviewTarget({
      kind: 'draft',
      id: null,
      commit: item.commit,
      historical: item.commit !== current.head,
      message: item.message,
    });
}
export function eyeLabel(item: { commit: string; stepId?: string; releaseId?: string }) {
  const current = s.current,
    d = s.displayedSelection,
    currentStep = !item.releaseId && item.commit === (current.presentationHead || current.head);
  const active = item.releaseId
    ? selectedReleaseId() === item.releaseId
    : !selectedReleaseId() &&
      !selectedSavedDraftId() &&
      (historicalContent() && item.stepId
        ? d?.kind === 'step' && item.stepId === d.id
        : item.commit === displayedPresentationCommit());
  return active && !currentStep
    ? t('back_to_current_draft')
    : currentStep
      ? t('show_current_draft')
      : t('preview_this_version');
}

// Settings: provider keys, team models and image models.
let catalogRequest = 0;
export function nextCatalogRequest() {
  return ++catalogRequest;
}
export function catalogRequestCurrent(request: number) {
  return request === catalogRequest;
}
// Unavailable models open AI settings by themselves once per browser; the same problems again stay in the menu.
function openForIssues(issues: string[]) {
  if (s.current?.publicationInProgress || !issues.length || s.settingsOpen) return;
  const signature = JSON.stringify([...issues].sort());
  try {
    if (localStorage.getItem('sitetiller-ai-settings-prompted') === signature) return;
    localStorage.setItem('sitetiller-ai-settings-prompted', signature);
  } catch {}
  openSettingsDialog(false);
}
export async function checkModels(autoOpen = false) {
  const request = ++catalogRequest;
  try {
    const list = await api('models');
    if (request !== catalogRequest) return;
    s.modelCatalog = list;
    s.availabilityIssues = list.issues || [];
    if (autoOpen) openForIssues(s.availabilityIssues);
  } catch (e: any) {
    if (request !== catalogRequest) return;
    s.availabilityIssues = [t('cannot_verify_model_availability') + e.message];
    if (autoOpen) openForIssues([t('cannot_verify_model_availability')]);
  }
}
let settingsOpener: (load: boolean) => void = () => {};
export function useSettingsOpener(open: (load: boolean) => void) {
  settingsOpener = open;
}
export function openSettingsDialog(load = true) {
  settingsOpener(load);
}

export async function afterRender() {
  await nextTick();
}
