import { providerIds, detectProvider } from '../../../packages/providers/index.mjs';
import { recommendedSetsUrl, recommendedLimit, parseRecommendationSets } from '../../../packages/models/index.mjs';
import {
  migrateTeams,
  teamOf,
  teamList,
  applyRecommended,
  createTeam,
  validTeamName,
} from './teams.ts';
import { Problem } from './problem.ts';
import { appVersion } from './app-version.ts';
import { readResponseLanguage } from './final-answer.ts';
import { deleteStepTarget } from './delete-step.ts';
import { finishConfirmedPublication } from './publication-finish.ts';
import { prepareWorkspacePublication } from './workspace-history.ts';
import { snapshotAccessSecret, issueSnapshotAccess, validSnapshotAccess } from './snapshot-access.ts';
import { savedDrafts, savedDraft, saveNamedDraft, removeNamedDraft, namedDraftPreview } from './saved-drafts.ts';
import { presentationState, loadedStepChanges, startingVersion } from './step-changes.ts';
import {
  publicationEvidence,
  confirmedPublicationEvidence,
  restoreConfirmedPublicationEvidence,
} from './publication-evidence.ts';
import { atomicJson } from '../../../packages/settings/index.mjs';
import { colourMode } from '../../../packages/settings/shared-ui.mjs';
import { writeApprovals } from './approvals.ts';
import { settingsSiteUrl } from './settings-site-url.ts';
async function editorName() {
  try {
    const settings = JSON.parse(
      await readFile(
        process.env.SITETILLER_SHARED_SETTINGS_FILE ||
          join(process.env.SITETILLER_CMS_ROOT || '', 'settings/shared.json'),
        'utf8',
      ),
    );
    return typeof settings.name === 'string' && settings.name.trim() ? settings.name.slice(0, 500) : 'SiteTiller';
  } catch {
    return 'SiteTiller';
  }
}
import { restoreContentState, restoredContent, applyRestoredContent } from './restore-content.ts';
import { contentSignature } from './content-signature.ts';
import { cmsSnapshotAsset } from './cms-snapshot-asset.ts';
import { decodeAttachment } from './images.ts';
import { publishedRoot } from './cms-preview.ts';
import { designContentMode } from './cms-design-source.ts';
import { previewCmsFiles, previewCmsAsset, cmsPreviewAvailable } from './cms-preview.ts';
import { capturePublicationSource, cmsContentDirty } from './cms-publication.ts';
import { renderCmsPage } from './cms-render.ts';
import { requestChecks } from './request-checks.ts';
import { serveForm } from './contact-forms.ts';
import { liveCms } from './cms-live.ts';
import { withDiagnostics, recordDiagnostic } from './diagnostics.ts';
import { languages } from '../../../packages/i18n/index.mjs';
const normalizeLocale = (value: unknown) =>
  typeof value === 'string' && Object.hasOwn(languages, value) ? value : 'en';
import { productionProject, syncProduction } from './production-history.ts';
import { rebaseWorkspace } from './workspace-history.ts';
import { restoreProduction } from './restore-production.ts';
import { compareReality, loadReality } from './reality.ts';
import { assistantStep } from './assistant-step.ts';
import { shareSnapshot, removeShareSnapshot, aliveShares } from './share-snapshot.ts';
import { importWebsite, publicUrl } from './web-import.ts';
import { realitySnapshot } from './reality-source.ts';
import { studioPreviewPolicy } from './site-policy.ts';
import { publicationTarget, publishableSteps } from './publication-target.ts';
import { draftState, clearDraftHistory } from './draft-state.ts';
import { closePublishedHistory, publicationSummary, visibleVersionHistory } from './publication-history.ts';
import { checkPublication, restorationSource } from './publication-check.ts';
import { cleanupPublication, mapCleanupHistory } from './image-cleanup.ts';
import { previewVersion, versionReferences } from './preview-version.ts';
import { previewDocument, previewLabel } from './preview-document.ts';
import { imageIssues, websiteImages } from './image-editor.ts';
import { decodeImage, selectImages, raster, binaryAsset, imageMime } from './images.ts';
import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { defaults, seal, unseal, resolveSiteFile, type Slot, type Provider } from './core.ts';
import { Project } from './project.ts';
import { workflow } from './workflow.ts';
import { closeStepsBefore, publicationClosing, unpublishedRequests } from './publication-history.ts';
import { runWithStop, StoppedError } from './run-control.ts';
import { browserChecks, checkLevel } from './checks.ts';
import { websiteGit, websiteState, websiteForeign } from './static-website.ts';
import {
  initialTeam,
  initialImages,
  validTeam,
  validImages,
  resolvePrimary,
  migrateAgentConfig,
  type Role,
} from './team.ts';
import { catalog, unavailable } from './catalog.ts';
import { addRequest } from './journal.ts';
import { recentConversation, searchConversation, hydrateRecentMemory } from './memory.ts';
import { initialReleases, publicationIntent, completePublication, groupHistory } from './releases.ts';
// AI Studio runs only behind the shared Shell; the gateway token is its sole authorization.
const gatewayToken = process.env.SITETILLER_GATEWAY_TOKEN;
if (!gatewayToken) throw Error('SITETILLER_GATEWAY_TOKEN is required: AI Studio runs only behind the shared Shell.');
const root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  data = resolve(process.env.SITETILLER_DATA_DIR || join(root, 'data'));
await mkdir(data, { recursive: true });
async function load(name: string, fallback: any) {
  try {
    return JSON.parse(await readFile(join(data, name), 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
// Errors carry their HTTP status: 409 for a busy studio or a changed state, 422 for invalid input; others answer 400.
async function save(name: string, value: any) {
  await atomicJson(join(data, name), value, { mode: name === 'config.json' ? 0o640 : 0o600 });
  if (name === 'config.json') await writeApprovals(data, value);
}
let key: Buffer;
try {
  key = await readFile(join(data, 'master.key'));
} catch (e: any) {
  if (e.code !== 'ENOENT') throw e;
  key = randomBytes(32);
  await writeFile(join(data, 'master.key'), key, { mode: 0o600 });
}
let config = await load('config.json', {
  slots: [
    { provider: 'openai', ...defaults.openai, key: '' },
    { provider: 'anthropic', ...defaults.anthropic, key: '' },
  ],
  approvedCommit: null,
  publishedCommit: null,
});
config.slots = config.slots || [];
delete config.password;
delete config.reviewRuns;
config.reviewedCommits = Array.from(
  new Set([...(config.reviewedCommits || []), config.approvedCommit, config.publishedCommit].filter(Boolean)),
);
config.providers =
  config.providers ||
  Object.fromEntries(
    ['openai', 'anthropic'].map((provider) => [
      provider,
      { key: config.slots.find((s: any) => s.provider === provider && s.key)?.key || '' },
    ]),
  );
if (migrateAgentConfig(config)) await save('config.json', config);
config.roles = config.roles || initialTeam();
config.imageModels = config.imageModels || initialImages();
await restoreConfirmedPublicationEvidence(data, config);
if (!config.automaticReasoningPolicy) {
  config.previousReasoningSettings = structuredClone(config.roles);
  config.roles.primary.reasoningEffort = 'auto';
  config.roles.ui.reasoningEffort = 'auto';
  config.roles.verify.reasoningEffort = 'auto';
  config.automaticReasoningPolicy = 1;
  await save('config.json', config);
}
// AI settings are the only key source; environment variables are deliberately ignored.
function providerKeys() {
  return Object.fromEntries(
    providerIds.map((provider) => [
      provider,
      config.providers[provider]?.key ? unseal(config.providers[provider].key, key) : '',
    ]),
  ) as Record<Provider, string>;
}
// Recommendation sets (documentation 4.6): the file shipped with the release and, in the providers mode, the current
// file from GitHub at most every 6 hours (at once after Update); the valid one with the higher revision wins.
const bundledRecommendation = parseRecommendationSets(
  await readFile(new URL('../../../packages/models/recommended-sets.json', import.meta.url), 'utf8'),
);
if (!bundledRecommendation) throw Error('The recommendation sets file shipped with the release is invalid');
let recommendationSource: { date: string; revision: number; source: 'bundled' | 'online' } = {
  date: bundledRecommendation.date,
  revision: bundledRecommendation.revision,
  source: 'bundled',
};
async function currentRecommendation(refresh = false) {
  const file = 'recommended-sets-online.json';
  let online: any = null;
  try {
    online = JSON.parse(await readFile(join(data, file), 'utf8'));
  } catch {}
  if (
    (process.env.SITETILLER_NETWORK_MODE || 'offline') === 'providers' &&
    (refresh || !online || Date.now() - Date.parse(online.fetchedAt) > 6 * 3600000)
  ) {
    try {
      const response = await fetch(recommendedSetsUrl, { signal: AbortSignal.timeout(10000) });
      const text = response.ok ? await response.text() : '';
      online = { fetchedAt: new Date().toISOString(), text: text.length <= recommendedLimit ? text : '' };
    } catch {
      online = { fetchedAt: new Date().toISOString(), text: online?.text || '' };
    }
    await save(file, online);
  }
  const fetched = online ? parseRecommendationSets(online.text) : null;
  // The higher revision wins (documentation 4.6).
  const value = fetched && fetched.revision > bundledRecommendation.revision ? fetched : bundledRecommendation;
  recommendationSource = {
    date: value.date,
    revision: value.revision,
    source: value === fetched ? 'online' : 'bundled',
  };
  return value;
}
if (migrateTeams(config, bundledRecommendation)) await save('config.json', config);
// The recommended teams follow their sets, the keys and the catalog; the default team is mirrored in config.roles.
async function applyTeams(models: any[], refresh = false) {
  if (applyRecommended(config, await currentRecommendation(refresh), models, providerKeys()))
    await save('config.json', config);
}
function activeSlots(): Slot[] {
  const keys = providerKeys();
  return (providerIds as Provider[]).map((provider) => ({
    provider,
    key: keys[provider],
    ...defaults[provider],
  }));
}
const project = new Project(join(data, 'project'), { objectReader: true });
await project.init(process.env.SITETILLER_INITIAL_SITE === 'seed' ? join(root, 'seed') : null);
let job: any = await load('last-job.json', null),
  busy = false;
// Stops the running edit request (POST /api/run/stop).
let runningStop: AbortController | null = null;
// Stops a running comparison or load of the live website (POST /api/reality/cancel).
let realityStop: AbortController | null = null;
const REALITY_CHECK_BUDGET = 60000;
// Mutating requests claim the studio synchronously, so of two concurrent requests the second gets 409.
function claim() {
  if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
  busy = true;
}
if (config.pendingRelease?.confirmedRelease)
  job = {
    ...job,
    status: 'ready',
    published: true,
    cleanupPending: true,
    release: config.pendingRelease.confirmedRelease,
  };
if (job?.status === 'running')
  job = { ...job, status: 'failed', error: 'Úloha byla přerušena restartem. Náhled zůstal zachován.' };
let events: any[] = await load('events.json', []);
if (!config.releases) {
  config.releases = initialReleases(config.publishedCommit, events);
  await save('config.json', config);
}
for (const request of config.requests || []) {
  if (request.status === 'running') {
    request.status = 'failed';
    request.error = 'Úloha byla přerušena restartem. Náhled zůstal zachován.';
    request.errorFromAgent = false;
    const event = {
      stage: 'failed',
      status: 'failed',
      message: request.error,
      jobId: request.id,
      kind: 'edit',
      at: new Date().toISOString(),
    };
    request.progress = [...(request.progress || []), event];
    events.push(event);
  }
}
await save('config.json', config);
await save('events.json', events);
await save('last-job.json', job);
config.lastReviewCommit =
  config.lastReviewCommit ||
  config.approvedCommit ||
  config.publishedCommit ||
  (await project.git(['rev-list', '--max-parents=0', 'HEAD']));
config.reviewedThrough = config.reviewedThrough || 0;
if (!config.requests) {
  config.requests = [];
  config.reviewedThrough = 0;
  config.lastReviewCommit =
    config.approvedCommit || config.publishedCommit || (await project.git(['rev-list', '--max-parents=0', 'HEAD']));
  const history = await project.git(['log', '--reverse', '--format=%H%x09%s', config.lastReviewCommit + '..HEAD']);
  for (const line of history.split('\n').filter(Boolean)) {
    const [commit, ...message] = line.split('\t');
    const text = message.join('\t');
    if (text.startsWith('SiteTiller: '))
      addRequest(config, {
        id: randomBytes(8).toString('hex'),
        prompt: job?.commit === commit && job?.prompt ? job.prompt : text.slice('SiteTiller: '.length),
        commit,
        status: 'legacy',
      });
  }
  if (
    job?.prompt &&
    !config.requests.some((r: any) => r.prompt === job.prompt) &&
    job.commit !== config.lastReviewCommit
  )
    addRequest(config, {
      id: randomBytes(8).toString('hex'),
      prompt: job.prompt,
      commit: job.commit || null,
      status: job.status,
    });
  await save('config.json', config);
}
const cleanedHistory = config.pendingRelease ? { events, removed: 0 } : closePublishedHistory(config, events);
events = cleanedHistory.events;
if (cleanedHistory.removed && job?.kind === 'edit' && !config.requests.some((r: any) => r.id === job.id)) {
  job = { id: job.id, kind: 'publish', status: 'ready', commit: config.publishedCommit };
  await save('last-job.json', job);
}
await save('config.json', config);
await save('events.json', events);
const PORT = Number(process.env.PORT || 8080),
  HOST = process.env.HOST || '127.0.0.1';
const publicOrigin = process.env.SITETILLER_ORIGIN || `http://127.0.0.1:${PORT}`;
const previewOrigin = new URL(process.env.SITETILLER_PREVIEW_URL || publicOrigin + '/preview/', publicOrigin).origin;
if (!['http:', 'https:'].includes(new URL(previewOrigin).protocol)) throw Error('Invalid preview origin');
function response(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req: http.IncomingMessage, limit = 1000000) {
  let bytes = 0,
    text = '';
  for await (const part of req) {
    bytes += part.length;
    if (bytes > limit) throw new Error('Příliš velký požadavek.');
    text += part;
  }
  return JSON.parse(text || '{}');
}
function auth(req: http.IncomingMessage) {
  const supplied = Buffer.from(String(req.headers['x-sitetiller-gateway'] || '')),
    expected = Buffer.from(gatewayToken!);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function sameOrigin(req: http.IncomingMessage) {
  return req.headers.origin === publicOrigin;
}
async function state() {
  return {
    networkMode: process.env.SITETILLER_NETWORK_MODE || 'offline',
    name: 'SiteTiller',
    version: appVersion,
    versionActions: 1,
    siteUrl: await siteUrl(),
    publicationInProgress: config.pendingRelease?.confirmedRelease
      ? { published: true, cleanupPending: true, release: config.pendingRelease.confirmedRelease }
      : null,
    hasDraftSteps: unpublishedRequests(config).length > 0,
    hasLoadedReality: !!config.realityCheckedAt || !!Object.keys(config.realityPaths || {}).length,
    agentArchitecture: 3,
    imageModels: config.imageModels,
    providers: Object.entries(providerKeys()).map(([provider, key]) => ({ provider, hasKey: !!key })),
    roles: config.roles,
    // AI teams (documentation 2.4): every team with its id, kind, name and models; the default one and a notice when
    // its recommendation set disappeared.
    teams: teamList(config, await currentRecommendation()),
    defaultTeam: config.defaultTeam,
    teamNotice: config.teamNotice || null,
    recommendation: recommendationSource,
    requests: config.requests,
    job,
    events,
    busy:
      busy ||
      !!(
        config.pendingRelease?.confirmedRelease ||
        config.pendingRelease?.publisherCommitted ||
        config.pendingRelease?.publisherUnknown
      ),
    lastReviewCommit: config.lastReviewCommit,
    approvedCommit: config.approvedCommit,
    publishedCommit: config.publishedCommit,
    releases: config.releases,
    previewUrl: process.env.SITETILLER_PREVIEW_URL || '/preview/',
    publishConfigured: !!process.env.SITETILLER_PUBLISH_URL,
    ...(await outsideLinks()),
  };
}
// Links out of the studio: the instance's published website and, while it is on, the public draft preview.
async function outsideLinks() {
  let publicPreview = false,
    chosen = '';
  try {
    const shared = JSON.parse(await readFile(process.env.SITETILLER_SHARED_SETTINGS_FILE || '', 'utf8'));
    publicPreview = shared.publicPreview === true;
    chosen = typeof shared.publicPreviewOrigin === 'string' ? shared.publicPreviewOrigin : '';
  } catch {}
  // The address set on Settings → Addresses and sharing, otherwise the installation's.
  const origin = chosen || process.env.SITETILLER_PUBLIC_PREVIEW_ORIGIN;
  return {
    liveSiteUrl: process.env.SITETILLER_SITE_URL || null,
    publicPreviewUrl: publicPreview && origin ? new URL(origin).origin + '/' : null,
    // External presentation: the outcome of the last write to the website Git (someone else's change, a failure).
    website: websiteGit() ? await websiteState() : null,
  };
}
const realitySnapshots = new Map<string, any>();

// The published website's address from the installation (documentation 4.5).
async function siteUrl() {
  return process.env.SITETILLER_SITE_URL || '';
}
let historyCache: any = null;
// Reading state never rebases or closes pending publication history.
async function synchronizeHistory() {
  return syncProduction(config);
}
async function historyState() {
  await synchronizeHistory();
  const head = await project.head(),
    signature =
      head +
      JSON.stringify([
        config.releases,
        config.draftBaseCommit,
        config.requests.map((r: any) => [r.id, r.commit, r.status, r.sequence]),
      ]);
  if (historyCache?.signature !== signature) {
    const history = visibleVersionHistory(await project.history(null), config),
      index = await project.binary(head, 'site/index.html').then(
        (bytes) => bytes.toString('utf8'),
        () => '',
      ),
      projectTitle = index.match(/<title>(.*?)<\/title>/s)?.[1]?.slice(0, 100) || 'Nový web';
    if (config.separatedHistories)
      for (const release of config.releases)
        if (!history.some((item) => item.commit === release.commit))
          history.push({
            commit: release.commit,
            message: 'Verze ' + release.number,
            date: release.publishedAt,
            production: true,
          });
    historyCache = {
      publishableCommits: await publishableSteps(project, config, head),
      signature,
      history,
      projectTitle,
      groups: groupHistory(history, config.releases),
    };
  }
  return {
    ...(await draftState(project, config, head)),
    head,
    publishableCommits: historyCache.publishableCommits,
    projectTitle: historyCache.projectTitle,
    history: historyCache.history,
    releaseGroups: historyCache.groups,
  };
}
async function imageInputs(items: any[]) {
  return Promise.all(
    items.map(async (i) => ({ ...i, data: (await readFile(join(data, 'uploads', i.id))).toString('base64') })),
  );
}
let eventWrites = Promise.resolve();
async function emit(event: any) {
  const value = {
    ...event,
    jobId: event.jobId || job?.id,
    kind: event.kind || job?.kind,
    at: new Date().toISOString(),
  };
  void recordDiagnostic('event', { event: value }).catch(() => {});
  const record = value.kind === 'edit' ? config.requests.find((r: any) => r.id === value.jobId) : null;
  if (record) {
    record.progress = record.progress || [];
    record.progress.push(value);
  }
  events.push(value);
  events = events.slice(-200);
  const snapshot = [...events];
  eventWrites = eventWrites.then(() => save('events.json', snapshot));
  await eventWrites;
}
const mime: any = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.txt': 'text/plain',
};
async function servePreview(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  // Only committed content is served. Sandbox isolates user-authored JS from studio origin.
  let record: any = null;
  if (url.pathname.startsWith('/preview/drafts/')) {
    const match = url.pathname.match(/^\/preview\/drafts\/(draft-[a-f0-9]{32})\/access\/([0-9]{13}-[a-f0-9]{64})\//),
      credentialRoute = /^\/preview\/drafts\/draft-[a-f0-9]{32}\/access\//.test(url.pathname);
    let allowed = false;
    if (match) {
      record = await savedDraft(project, match[1]);
      allowed = validSnapshotAccess(await snapshotAccessSecret(project), record.id, record.commit, match[2]);
    }
    if (credentialRoute ? !allowed : !auth(req)) {
      res.writeHead(401);
      return res.end();
    }
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405);
      return res.end();
    }
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  const version = (await namedDraftPreview(project, url, record)) || (await previewVersion(project, url, true));
  if (!version) {
    res.writeHead(404);
    return res.end('Verze nenalezena');
  }
  const { commit, relative, prefix } = version,
    selected = version.project || project,
    files = await selected.committedFiles(commit);
  if (
    await serveForm(req, res, relative, files, {
      preview: true,
      origin: new URL(req.url || '/', 'http://' + req.headers.host).origin,
    })
  )
    return;
  if (!version.frozen && (version.cmsMode || (selected.root === project.root && commit === (await project.head())))) {
    const live = version.cmsMode ? await previewCmsAsset(relative, version.cmsMode) : await liveCms(relative);
    if (live) {
      res.writeHead(live.status, {
        'Content-Type': live.mime,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': studioPreviewPolicy,
      });
      return res.end(req.method === 'HEAD' ? undefined : live.body);
    }
  }
  const snapshotAsset = cmsSnapshotAsset(relative, files),
    name = snapshotAsset || resolveSiteFile('/' + relative, files);
  if (!Object.hasOwn(files, name)) {
    res.writeHead(404);
    return res.end('Nenalezeno');
  }
  if (!snapshotAsset && !url.pathname.endsWith('/') && !Object.hasOwn(files, 'site/' + relative)) {
    res.writeHead(302, { Location: url.pathname + '/' + url.search });
    return res.end();
  }
  let content: any = binaryAsset(name) ? await (version.project || project).binary(commit, name) : files[name];
  // Root-relative website links remain inside the studio's isolated preview route.
  if (name.endsWith('.html'))
    content =
      (await renderCmsPage(
        name,
        await previewCmsFiles(files, version.cmsMode),
        !version.frozen &&
          (version.cmsMode === 'unpublished' ||
            (!version.cmsMode && selected.root === project.root && commit === (await project.head()))),
      )) || content;
  if (/\.(html|css)$/.test(name)) content = versionReferences(content, prefix);
  if (name.endsWith('.html'))
    content = previewDocument(
      content,
      commit,
      url.searchParams.get('embedded') === '1',
      await previewLabel(project, commit),
    );
  // A frozen version is addressed by its commit, so its responses never change.
  res.writeHead(200, {
    'Content-Type': raster(name) ? imageMime(name) : mime[extname(name).toLowerCase()] || 'application/octet-stream',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': version.frozen ? 'private, max-age=31536000, immutable' : 'no-store',
    'Content-Security-Policy': studioPreviewPolicy,
  });
  res.end(content);
}
let maintenance = false;
async function observePublisher() {
  if (!config.pendingRelease || !process.env.SITETILLER_PUBLISH_URL) return null;
  const url = new URL('/publication-status', process.env.SITETILLER_PUBLISH_URL);
  url.searchParams.set('commit', config.pendingRelease.commit);
  const reply = await fetch(url, {
    headers: { Authorization: 'Bearer ' + process.env.SITETILLER_PUBLISH_TOKEN },
    signal: AbortSignal.timeout(10000),
  });
  return reply.ok ? await reply.json() : null;
}
async function internalPublicationFinish() {
  if (maintenance || busy || !config.pendingRelease) return;
  maintenance = true;
  busy = true;
  try {
    if (!config.pendingRelease.confirmedRelease) {
      const status = await observePublisher();
      if (status?.committed) {
        config.pendingRelease.publisherCommitted = true;
        config.pendingRelease.publisherUnknown = false;
        if (status.release) config.pendingRelease.confirmedRelease = status.release;
        await confirmedPublicationEvidence(data, config.pendingRelease);
        await save('config.json', config);
      }
      if (!config.pendingRelease.confirmedRelease) return;
    }
    const finished = await finishConfirmedPublication(project, data, config, events, job);
    config = finished.config;
    events = finished.events;
    job = finished.job;
    historyCache = null;
  } catch (e: any) {
    console.error('Internal publication finalization pending: ' + (e.code || e.name));
  } finally {
    busy = false;
    maintenance = false;
  }
}
await internalPublicationFinish();
let finishDelay = 1000;
function schedulePublicationFinish() {
  const timer = setTimeout(async () => {
    await internalPublicationFinish();
    finishDelay = config.pendingRelease ? Math.min(finishDelay * 2, 60000) : 1000;
    schedulePublicationFinish();
  }, finishDelay);
  timer.unref();
}
schedulePublicationFinish();
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url || '/', publicOrigin),
      path = url.pathname;
    if (path === '/health') return response(res, 200, { ok: true });
    if (path === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    if (path.startsWith('/preview/')) return await servePreview(req, res, url);
    if (path.startsWith('/api/')) {
      const mutating = req.method !== 'GET';
      if (mutating && !sameOrigin(req)) return response(res, 403, { error: 'Nepovolený původ požadavku.' });
      if (path === '/api/session' && req.method === 'GET') return response(res, 200, { authenticated: auth(req) });
      if (!auth(req)) return response(res, 401, { error: 'Přihlas se do SiteTiller.' });
      if (
        (config.pendingRelease?.confirmedRelease ||
          config.pendingRelease?.publisherCommitted ||
          config.pendingRelease?.publisherUnknown) &&
        mutating
      )
        throw new Problem(409, 'Publikování se interně dokončuje.');
      if (path === '/api/design-content-status' && req.method === 'GET') {
        if (!process.env.SITETILLER_CMS_ROOT) return response(res, 200, { unpublished: false });
        const upstream = await fetch((process.env.SITETILLER_CMS_URL || 'http://127.0.0.1:4310') + '/api/publication', {
          signal: AbortSignal.timeout(10000),
        });
        const status = await upstream.json();
        if (!upstream.ok || typeof status.unpublished !== 'boolean')
          throw Error('Nelze ověřit nepublikované úpravy obsahu.');
        return response(res, 200, { unpublished: status.unpublished });
      }
      if (path === '/api/state' && req.method === 'GET') {
        for (let attempt = 0; attempt < 3; attempt++) {
          const history = await historyState(),
            snapshot = {
              ...(await state()),
              ...history,
              ...presentationState(config, history.head),
              savedDrafts: await savedDrafts(project),
              editorName: await editorName(),
              cmsPreviewSources: await cmsPreviewAvailable(),
              contentSignature: await contentSignature(),
            };
          if (process.env.SITETILLER_CMS_ROOT && process.env.SITETILLER_PUBLISH_URL) {
            snapshot.cmsDirty = await cmsContentDirty(project, process.env.SITETILLER_CMS_ROOT);
            if (snapshot.cmsDirty && !snapshot.publishableCommits.includes(history.head))
              snapshot.publishableCommits.push(history.head);
            snapshot.hasDraftSteps = snapshot.hasDraftSteps || snapshot.cmsDirty;
          }
          if (
            history.head === (await project.head()) &&
            snapshot.busy ===
              (busy ||
                !!(
                  config.pendingRelease?.confirmedRelease ||
                  config.pendingRelease?.publisherCommitted ||
                  config.pendingRelease?.publisherUnknown
                ))
          ) {
            /* Unchanged state answers 304 without a body; the client keeps its copy. */ const text =
                JSON.stringify(snapshot),
              etag = createHash('sha1').update(text).digest('hex');
            if (req.headers['x-state-etag'] === etag) {
              res.writeHead(304, { 'x-state-etag': etag, 'Cache-Control': 'no-store' });
              return res.end();
            }
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'x-state-etag': etag,
            });
            return res.end(text);
          }
          historyCache = null;
        }
        throw new Problem(409, 'Návrh se právě mění. Obnovte stav.');
      }
      if (path === '/api/models' && (req.method === 'GET' || req.method === 'POST')) {
        const input = req.method === 'POST' ? await body(req) : {};
        const keys = providerKeys();
        for (const provider of providerIds as Provider[]) {
          const value = input.keys?.[provider];
          if (value !== undefined) {
            if (typeof value !== 'string' || value.length > 512) throw new Problem(422, 'Neplatný klíč.');
            if (value.trim()) keys[provider] = value.trim();
          }
        }
        const list = await catalog(keys);
        await applyTeams(list.models);
        const resolved = resolvePrimary(config.roles, list.models);
        return response(res, 200, {
          ...list,
          issues: unavailable(resolved, list, ['primary']),
          optionalIssues: [
            ...unavailable(resolved, list, ['ui', 'verify', 'escalation']),
            ...Object.values(config.imageModels).flatMap((model: any) => imageIssues(model, list.models)),
          ],
        });
      }
      // Add a key (Settings → AI Studio models, documentation 2.4): the provider told by the key's shape, the key checked
      // with that provider's model list only; a key the provider refuses is not saved.
      if (path === '/api/keys/add' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req),
          value = typeof input.key === 'string' ? input.key.trim() : '',
          detected = detectProvider(value);
        if (!detected.provider || detected.provider !== input.provider || value.length > 512)
          throw new Problem(422, 'Neplatný klíč.');
        const provider = detected.provider as Provider,
          keys = Object.fromEntries(providerIds.map((p) => [p, p === provider ? value : ''])) as Record<
            Provider,
            string
          >,
          checked = (await catalog(keys)).providers.find((p) => p.provider === provider)!;
        if (['authentication', 'access'].includes(checked.errorKind || ''))
          throw new Problem(422, 'Klíč se neuložil: ' + (checked as any).detail + '.');
        config.providers = { ...config.providers, [provider]: { key: seal(value, key) } };
        await save('config.json', config);
        // The recommended teams follow the keys at once (documentation 2.4).
        await applyTeams((await catalog(providerKeys())).models);
        return response(res, 200, { ok: true, provider, warning: checked.error || null });
      }
      // Remove a key (Settings → AI Studio models, documentation 2.4): it is deleted even when the team then has no
      // usable model; the page says so.
      if (path === '/api/keys/remove' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (!providerIds.includes(input.provider)) throw new Problem(422, 'Neznámý poskytovatel.');
        config.providers = { ...config.providers, [input.provider]: { key: '' } };
        await save('config.json', config);
        // The recommended teams follow the keys at once (documentation 2.4).
        await applyTeams((await catalog(providerKeys())).models);
        return response(res, 200, { ok: true });
      }
      // AI teams (documentation 2.4): save a custom team, make a team the default one, create a custom team as a copy of
      // a shown one, delete a custom team, or update the recommendation. Without an action the default team is saved.
      if (path === '/api/settings' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (input.siteUrl !== undefined) throw Error('Adresa webu je adresa publikovaného webu z instalace.');
        const action = input.action ?? 'save';
        if (!['save', 'default', 'create', 'delete', 'refresh'].includes(action))
          throw new Problem(422, 'Neplatná volba týmu.');
        if (input.teamId !== undefined && typeof input.teamId !== 'string') throw new Problem(422, 'Tým neexistuje.');
        const teamId = input.teamId ?? config.defaultTeam,
          recommendation = await currentRecommendation(action === 'refresh'),
          shown = teamOf(config, recommendation, teamId);
        if (!shown) throw new Problem(422, 'Tým neexistuje.');
        if (action === 'create') {
          const team = createTeam(config, shown);
          await save('config.json', config);
          return response(res, 200, { ok: true, teamId: team.id });
        }
        if (action === 'delete') {
          if (shown.kind !== 'custom') throw new Problem(422, 'Doporučený tým smazat nejde.');
          if (teamId === config.defaultTeam)
            throw new Problem(422, 'Výchozí tým smazat nejde. Nejdřív nastavte jiný tým jako výchozí.');
          config.teams = config.teams.filter((team: any) => team.id !== teamId);
          await save('config.json', config);
          return response(res, 200, { ok: true, teamId: config.defaultTeam });
        }
        if (action === 'save') {
          if (shown.kind !== 'custom') throw new Problem(422, 'Doporučený tým se nastavuje podle doporučení.');
          if (input.name !== undefined && !validTeamName(input.name))
            throw new Problem(422, 'Název týmu musí mít 1 až 40 znaků.');
          if (input.imageModels && typeof input.imageModels === 'object')
            input.imageModels = { precise: input.imageModels.precise, fast: input.imageModels.fast };
          if (!validTeam(input.roles) || !validImages(input.imageModels))
            throw new Problem(422, 'Vyber model pro každou capability.');
        }
        const saved = providerKeys(),
          keys = { ...saved },
          providers = structuredClone(config.providers),
          entered: string[] = [];
        for (const provider of providerIds as Provider[]) {
          const value = input.keys?.[provider];
          if (value !== undefined) {
            if (typeof value !== 'string' || value.length > 512) throw new Problem(422, 'Neplatný klíč.');
            if (value.trim()) {
              keys[provider] = value.trim();
              providers[provider] = { key: seal(value.trim(), key) };
              entered.push(provider);
            }
          }
        }
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        claim();
        try {
          let list = await catalog(keys);
          const rejectedKeys: Record<string, string> = {};
          for (const p of list.providers)
            if (entered.includes(p.provider) && ['authentication', 'access'].includes(p.errorKind || '')) {
              rejectedKeys[p.provider] = (p as any).detail;
              keys[p.provider] = saved[p.provider];
              providers[p.provider] = config.providers[p.provider];
            }
          if (Object.keys(rejectedKeys).length) list = await catalog(keys);
          // Saving the default team checks its Web Lead; any other team, and making a team the default one, only
          // warns: the team is where an unavailable model is fixed.
          const roles = action === 'save' ? input.roles : shown.roles,
            resolved = resolvePrimary(roles, list.models),
            issues = unavailable(resolved, list, ['primary']);
          if (action === 'save' && teamId === config.defaultTeam && issues.length)
            return response(res, 400, { error: issues.join('\n') });
          if (action === 'save') {
            const team = config.teams.find((t: any) => t.id === teamId);
            Object.assign(team, {
              roles: input.roles,
              imageModels: input.imageModels,
              ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            });
          }
          if (action === 'default') {
            config.defaultTeam = teamId;
            delete config.teamNotice;
          }
          config.providers = providers;
          applyRecommended(config, recommendation, list.models, keys);
          await save('config.json', config);
          const team = teamOf(config, recommendation, teamId)!;
          return response(res, 200, {
            ok: true,
            teamId,
            rejectedKeys,
            catalog: list,
            optionalIssues: [
              ...unavailable(resolvePrimary(team.roles, list.models), list, ['primary', 'ui', 'verify', 'escalation']),
              ...Object.values(team.imageModels).flatMap((model: any) => imageIssues(model, list.models)),
            ],
          });
        } finally {
          busy = false;
        }
      }
      if (path === '/api/images' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const image = decodeAttachment(await body(req, 7100000));
        const uploads = config.uploads || [];
        if (
          !uploads.some((i: any) => i.id === image.id) &&
          uploads.reduce((n: number, i: any) => n + i.size, 0) + image.bytes.length > 100 * 1024 * 1024
        )
          throw Error('Úložiště obrázků dosáhlo limitu 100 MB.');
        await mkdir(join(data, 'uploads'), { recursive: true });
        await writeFile(join(data, 'uploads', image.id), image.bytes, { mode: 0o600 });
        const info = { id: image.id, name: image.name, mime: image.mime, size: image.bytes.length };
        config.uploads = [...uploads.filter((i: any) => i.id !== image.id), info];
        await save('config.json', config);
        return response(res, 201, info);
      }
      if (path.startsWith('/api/images/') && req.method === 'GET') {
        const id = path.slice(12),
          image = (config.uploads || []).find((i: any) => i.id === id);
        if (!image) return response(res, 404, { error: 'Obrázek nenalezen.' });
        res.writeHead(200, { 'Content-Type': image.mime, 'Cache-Control': 'no-store' });
        return res.end(await readFile(join(data, 'uploads', image.id)));
      }
      if (path === '/api/run' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Jiná úloha právě běží.');
        const input = await body(req);
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 6000)
          throw new Problem(422, 'Zadej požadavek do 6000 znaků.');
        const responseLanguage = await readResponseLanguage(
          process.env.SITETILLER_SHARED_SETTINGS_FILE ||
            (process.env.SITETILLER_CMS_ROOT
              ? join(process.env.SITETILLER_CMS_ROOT, 'settings/shared.json')
              : undefined),
        );
        const checks = requestChecks(input.checks),
          cmsSource = designContentMode(input.cmsSource ?? 'published');
        if (input.cmsSource !== undefined && !(await cmsPreviewAvailable())[cmsSource])
          throw Error('Vybraný obsah pro návrh není dostupný.');
        const reasoningEffort = input.reasoningEffort ?? 'auto';
        if (!['auto', 'low', 'medium', 'high'].includes(reasoningEffort))
          throw new Problem(422, 'Neplatná míra uvažování.');
        const mode = input.mode || 'edit';
        if (!['edit', 'redesign', 'create'].includes(mode)) throw new Problem(422, 'Neplatný rozsah požadavku.');
        const attachments = selectImages(input.attachments, config.uploads || []);
        if (attachments.reduce((n: number, i: any) => n + i.size, 0) > 12 * 1024 * 1024)
          throw new Problem(422, 'Přílohy dohromady musí mít nejvýše 12 MB.');
        const images = await imageInputs(attachments);
        if (input.team !== undefined && typeof input.team !== 'string') throw new Problem(422, 'Tým neexistuje.');
        const list = await catalog(providerKeys());
        await applyTeams(list.models);
        // The chosen team (documentation 4.2), the default one otherwise; it is frozen for the whole request.
        const team = teamOf(config, await currentRecommendation(), input.team ?? config.defaultTeam);
        if (!team) throw new Problem(422, 'Tým neexistuje.');
        const resolvedTeam = resolvePrimary(team.roles, list.models),
          issues = unavailable(resolvedTeam, list, ['primary']);
        if (issues.length) throw new Error(issues.join('\n'));
        if (busy) throw new Problem(409, 'Jiná úloha právě běží.');
        claim();
        const stop = new AbortController();
        runningStop = stop;
        const priorRequests = structuredClone([...(config.conversationMemory || []), ...config.requests]),
          baseCommit = await project.head();
        const request = addRequest(config, {
          id: randomBytes(8).toString('hex'),
          prompt: input.prompt.trim(),
          responseLanguage,
          mode,
          reasoningEffort,
          checks,
          cmsSource,
          attachments,
          models: structuredClone(team.roles),
          team: { id: team.id, kind: team.kind, name: team.name },
          status: 'running',
          baseCommit,
          createdAt: new Date().toISOString(),
        });
        config.approvedCommit = null;
        job = { id: request.id, kind: 'edit', status: 'running', prompt: request.prompt, attachments };
        await save('config.json', config);
        await save('last-job.json', job);
        await emit({ stage: 'request', message: request.prompt, attachments });
        void (async () => {
          try {
            await hydrateRecentMemory(project, priorRequests);
            for (const prior of priorRequests) {
              const saved = config.requests.find((r: any) => r.id === prior.id);
              if (saved && !saved.memory && prior.memory) saved.memory = prior.memory;
            }
            const result = await withDiagnostics(
              data,
              { id: request.id, kind: 'edit', prompt: request.prompt, models: resolvedTeam, baseCommit, attachments },
              Object.values(providerKeys()),
              () =>
                runWithStop(stop.signal, () =>
                  workflow(
                    project,
                    activeSlots(),
                    request.prompt,
                    join(data, 'drafts'),
                    (e) => {
                      void emit(e);
                    },
                    undefined,
                    resolvedTeam,
                    images,
                    {
                      responseLanguage: request.responseLanguage,
                      mode,
                      reasoningEffort,
                      requestChecks: checks,
                      cmsSource,
                      conversation: recentConversation(priorRequests, baseCommit),
                      history: (query) => searchConversation(priorRequests, query, baseCommit),
                      publication: () => ({ publishedCommit: config.publishedCommit || null }),
                      imageModels: team.imageModels,
                      availableModels: list.models,
                    },
                  ),
                ),
            );
            Object.assign(request, {
              status: result.conversationOnly ? 'answered' : 'ready',
              commit: result.commit,
              scope: result.scope,
              finalAnswer: result.finalAnswer,
              resolvedRequest: result.resolvedRequest,
              memory: result.memory,
              plan: result.plan,
              imageResults: result.imageResults,
              tests: result.tests,
              presentationChanged: result.presentationChanged,
              contentChanged: result.contentChanged,
              changeKind: result.changeKind,
              changedPaths: result.changedPaths,
            });
            startingVersion(config);
            if (!result.conversationOnly) {
              if (request.presentationChanged) {
                config.presentationHead = result.commit;
                config.presentationStepId = request.id;
              } else if (!config.presentationHead) {
                config.presentationHead = baseCommit;
                config.presentationStepId =
                  config.requests.findLast(
                    (r: any) => r.id !== request.id && r.presentationChanged !== false && r.commit,
                  )?.id || null;
              }
            }
            if (result.webImport?.resources)
              config.realityPaths = {
                ...(config.realityPaths || {}),
                ...Object.fromEntries(result.webImport.resources.map((r: any) => [r.path, r.url])),
              };
            job = { ...job, status: 'ready', ...result };
          } catch (caught: any) {
            // A stopped request ends without a step; whatever the interrupted code reported, it says so.
            const e = stop.signal.aborted ? new StoppedError() : caught;
            request.status = 'failed';
            request.error = e.message;
            if (stop.signal.aborted) request.stopped = true;
            if (e.finalAnswer) request.finalAnswer = e.finalAnswer;
            request.errorFromAgent = !!e.agentResponse;
            job = { ...job, status: 'failed', error: e.message };
            await emit({ stage: 'failed', message: e.message, agentResponse: !!e.agentResponse });
          } finally {
            await save('config.json', config);
            await save('last-job.json', job);
            if (runningStop === stop) runningStop = null;
            busy = false;
          }
        })();
        return response(res, 202, { job });
      }
      if (path === '/api/run/stop' && req.method === 'POST') {
        await body(req);
        if (!runningStop || job?.kind !== 'edit' || job.status !== 'running')
          throw new Problem(409, 'Žádný požadavek neběží.');
        runningStop.abort();
        await emit({ stage: 'stopping', message: 'Zastavuji požadavek.' });
        return response(res, 202, { stopping: true });
      }
      if (path === '/api/reality/image' && req.method === 'GET') {
        const cached = realitySnapshots.get(url.searchParams.get('token') || ''),
          name = url.searchParams.get('path') || '';
        if (!cached || Date.now() - cached.created > 10 * 60 * 1000 || !raster(name) || !cached.snapshot.binary[name])
          return response(res, 404, { error: 'Obrázek není dostupný.' });
        res.writeHead(200, {
          'Content-Type': imageMime(name),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(cached.snapshot.binary[name]);
      }
      if (path === '/api/reality/compare' && req.method === 'POST') {
        await syncProduction(config);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        // The published website, or another address for this one comparison (taking over a website from elsewhere).
        let url = await siteUrl();
        if (input.url !== undefined) {
          if (typeof input.url !== 'string' || input.url.length > 2000) throw new Problem(422, 'Neplatná adresa webu.');
          try {
            url = settingsSiteUrl(input.url);
          } catch {
            throw new Problem(422, 'Zadejte veřejnou HTTP/HTTPS adresu bez přihlašovacích údajů.');
          }
        }
        if (!url) throw new Problem(422, 'Instance nemá adresu publikovaného webu. Zadejte adresu webu k načtení.');
        claim();
        try {
          const head = await project.head();
          if (input.expectedHead !== head) throw new Problem(409, 'Návrh se mezitím změnil.');
          if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit))
            throw new Problem(422, 'Neplatná verze.');
          if (!config.separatedHistories || !config.releases.some((r) => r.commit === input.commit))
            await project.git(['merge-base', '--is-ancestor', input.commit, head]);
          const stop = (realityStop = new AbortController()),
            { snapshot, result } = await runWithStop(stop.signal, async () => {
              const snapshot = await realitySnapshot(
                publicUrl(url).href,
                process.env.SITETILLER_PUBLISH_URL,
                process.env.SITETILLER_PUBLISH_TOKEN,
              );
              if (stop.signal.aborted) throw new StoppedError();
              return {
                snapshot,
                result: await compareReality(project, config, input.commit, snapshot, productionProject()),
              };
            }).catch((e) => {
              console.error('Live website comparison failed: ' + (e.message || e.name));
              if (stop.signal.aborted) throw new Problem(409, 'Načítání bylo zrušeno.');
              throw e;
            }),
            token = randomBytes(24).toString('hex');
          realityStop = null;
          for (const [key, value] of realitySnapshots)
            if (Date.now() - value.created > 10 * 60 * 1000) realitySnapshots.delete(key);
          while (realitySnapshots.size >= 3) realitySnapshots.delete(realitySnapshots.keys().next().value!);
          realitySnapshots.set(token, {
            snapshot,
            head,
            url,
            publication: config.publishedCommit || null,
            equal: result.equal,
            liveMatchesPublished: result.liveMatchesPublished,
            created: Date.now(),
          });
          return response(res, 200, { ...result, token });
        } finally {
          busy = false;
        }
      }
      if (path === '/api/reality/cancel' && req.method === 'POST') {
        if (!realityStop) throw new Problem(409, 'Nic se nenačítá.');
        realityStop.abort();
        return response(res, 200, { ok: true });
      }
      // An AI assistant's step over MCP (documentation 2.8); the Shell checks access and permissions.
      if (path === '/api/assistant-step' && req.method === 'POST') {
        if (busy || config.pendingRelease) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req, 25000000);
        claim();
        try {
          const request = await assistantStep(project, config, input);
          await save('config.json', config);
          historyCache = null;
          return response(res, 200, {
            ok: true,
            step: request.sequence,
            commit: request.commit,
            checks: request.tests.passed ? 'passed' : 'warnings',
            warnings: request.tests.warnings,
          });
        } finally {
          busy = false;
        }
      }
      // Shared previews (documentation 4.10): freeze and pin the shared state; the Shell keeps the list of links.
      if (path === '/api/share-snapshot' && req.method === 'POST') {
        if (busy || config.pendingRelease) throw new Problem(409, 'Počkej na dokončení úlohy nebo publikování.');
        const input = await body(req);
        claim();
        try {
          return response(res, 200, await shareSnapshot(project, config, input));
        } finally {
          busy = false;
        }
      }
      if (path === '/api/share-snapshot/alive' && req.method === 'POST')
        return response(res, 200, { alive: await aliveShares(project, config, (await body(req)).ids) });
      if (path === '/api/share-snapshot/remove' && req.method === 'POST') {
        await removeShareSnapshot(project, (await body(req)).id);
        return response(res, 200, { ok: true });
      }
      // Website files of the latest step, for the assistant to read (documentation 2.8).
      if (path === '/api/site-files' && req.method === 'GET') {
        const head = await project.head(),
          files = await project.committedFiles(head),
          name = url.searchParams.get('path');
        if (!name)
          return response(res, 200, {
            commit: head,
            files: Object.keys(files)
              .filter((p) => !p.startsWith('site/cms/'))
              .sort(),
          });
        if (!Object.hasOwn(files, name)) throw new Problem(404, 'Soubor v posledním kroku neexistuje: ' + name);
        return response(
          res,
          200,
          binaryAsset(name)
            ? { commit: head, path: name, base64: (await project.binary(head, name)).toString('base64') }
            : { commit: head, path: name, text: files[name] },
        );
      }
      if (path === '/api/reality/load' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const cached = realitySnapshots.get(input.token);
        if (
          !cached ||
          Date.now() - cached.created > 10 * 60 * 1000 ||
          cached.publication !== (config.publishedCommit || null)
        )
          throw new Problem(409, 'Porovnání již není aktuální. Porovnej web znovu.');
        if (
          input.expectedHead !== cached.head ||
          typeof input.clearPrevious !== 'boolean' ||
          typeof input.saveVersion !== 'boolean'
        )
          throw new Problem(422, 'Neplatné potvrzení načtení webu.');
        if (cached.equal) throw Error('Zobrazená verze se shoduje se skutečným webem. Není co načítat.');
        if (input.saveVersion && cached.liveMatchesPublished)
          throw Error('Skutečný web již odpovídá uložené publikované verzi. Nová verze není potřeba.');
        claim();
        try {
          if (
            config.separatedHistories &&
            input.saveVersion &&
            (!Number.isInteger(input.versionNumber) ||
              input.versionNumber < 0 ||
              input.versionNumber > 999999 ||
              config.releases.some((r) => r.number === input.versionNumber) ||
              cached.snapshot.evidence.source !== 'hosting-http')
          )
            throw Error('Vyber volné číslo verze skutečného webu připojeného k hostingu.');
          // The checks of the loaded website have a time budget; the user can cancel the load until it is written.
          const stop = (realityStop = new AbortController()),
            budget = AbortSignal.timeout(REALITY_CHECK_BUDGET),
            beforeLoad = structuredClone(config),
            result = await loadReality(
              project,
              config,
              cached.snapshot,
              cached.head,
              input.clearPrevious,
              (path: string, files: Record<string, string>) =>
                runWithStop(AbortSignal.any([stop.signal, budget]), () => browserChecks(path, files)),
              config.separatedHistories ? false : input.saveVersion,
              input.versionNumber,
            ).catch((e) => {
              console.error('Live website load failed: ' + (e.message || e.name));
              if (stop.signal.aborted) throw new Problem(409, 'Načítání bylo zrušeno. Návrh zůstal beze změny.');
              if (budget.aborted) throw Error('Kontrola načteného webu nedoběhla do 60 s. Návrh zůstal beze změny.');
              throw e;
            });
          realityStop = null;
          if (config.separatedHistories && input.saveVersion) {
            try {
              await save('config.json', config);
              const endpoint = new URL(process.env.SITETILLER_PUBLISH_URL!);
              endpoint.pathname = endpoint.pathname.replace(/publish$/, 'archive');
              const archived = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + process.env.SITETILLER_PUBLISH_TOKEN,
                },
                body: JSON.stringify({ commit: result.commit, number: input.versionNumber }),
                signal: AbortSignal.timeout(90000),
              });
              const value: any = await archived.json();
              if (!archived.ok) throw Error(value.error || 'Uložení skutečné verze selhalo.');
              await syncProduction(config);
            } catch (error) {
              await syncProduction(config);
              if (!config.releases.some((r) => r.number === input.versionNumber && r.sourceCommit === result.commit)) {
                await project.rewind(cached.head, result.commit, null);
                config = beforeLoad;
                await save('config.json', config);
                historyCache = null;
                throw error;
              }
            }
            result.savedVersion = input.versionNumber;
            config.draftBaseCommit = result.commit;
          }
          if (config.separatedHistories && input.clearPrevious) {
            await rebaseWorkspace(project, project, result.commit, result.commit, []);
            if (result.request) {
              result.request.baseCommit = null;
              config.requests = [result.request];
            }
            config.draftBaseCommit = result.commit;
            config.lastReviewCommit = result.commit;
          }
          if (input.clearPrevious || (result.first && !result.request)) {
            await eventWrites;
            events = [];
            await save('events.json', events);
          }
          job = result.request
            ? {
                id: result.request.id,
                kind: 'edit',
                status: 'ready',
                commit: result.commit,
                plan: { summary: result.request.memory.summary },
                tests: result.request.tests,
              }
            : null;
          if (result.request) {
            await emit({ stage: 'request', jobId: result.request.id, kind: 'edit', message: result.request.prompt });
            await emit({
              stage: 'build',
              status: 'completed',
              jobId: result.request.id,
              kind: 'edit',
              message: result.request.memory.summary,
              commit: result.commit,
            });
            await emit({
              stage: 'ready',
              jobId: result.request.id,
              kind: 'edit',
              commit: result.commit,
              message: 'Web byl načten do návrhu.',
            });
          }
          await save('config.json', config);
          await save('last-job.json', job);
          historyCache = null;
          realitySnapshots.clear();
          return response(res, 200, { ok: true, commit: result.commit, savedVersion: result.savedVersion });
        } finally {
          busy = false;
        }
      }
      if (path === '/api/drafts/preview' && req.method === 'POST') {
        const input = await body(req),
          record = await savedDraft(project, input.id),
          access = issueSnapshotAccess(await snapshotAccessSecret(project), record.id, record.commit);
        return response(res, 200, {
          url: '/preview/drafts/' + record.id + '/access/' + access.token + '/',
          expires: access.expires,
        });
      }
      if (path === '/api/drafts' && req.method === 'GET')
        return response(res, 200, { drafts: await savedDrafts(project) });
      if (path === '/api/drafts/remove' && req.method === 'POST') {
        if (busy || config.pendingRelease) throw new Problem(409, 'Počkej na dokončení úlohy nebo publikování.');
        const input = await body(req);
        claim();
        try {
          return response(res, 200, await removeNamedDraft(project, input));
        } finally {
          busy = false;
        }
      }
      if (path === '/api/drafts/save' && req.method === 'POST') {
        if (busy || config.pendingRelease) throw new Problem(409, 'Počkej na dokončení úlohy nebo publikování.');
        const input = await body(req);
        if (input.clearPrevious !== undefined && typeof input.clearPrevious !== 'boolean')
          throw new Problem(422, 'Neplatná volba předchozích kroků.');
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        claim();
        try {
          const head = await project.head(),
            record = await saveNamedDraft(project, {
              name: input.name,
              expectedHead: input.expectedHead,
              cmsSource: input.cmsSource,
              commit: input.commit,
              presentationHead: input.commit || presentationState(config, head).presentationHead,
            });
          // "Remove previous steps": the saved step and those before it become a new first step (documentation 4.9).
          const step =
            input.clearPrevious &&
            config.requests.findLast((r: any) => r.commit === record.step && ['ready', 'legacy'].includes(r.status));
          if (step) {
            await eventWrites;
            const closed = closeStepsBefore(config, events, step, {
              id: record.id,
              name: record.name,
              commit: record.commit,
            });
            if (closed.events !== events) {
              events = closed.events;
              await save('config.json', config);
              await save('events.json', events);
              historyCache = null;
            }
          }
          return response(res, 200, { draft: record });
        } finally {
          busy = false;
        }
      }
      if (path === '/api/restore/prepare' && req.method === 'POST') {
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (input.expectedHead !== (await project.head())) throw new Problem(409, 'Návrh se mezitím změnil.');
        const named = input.draftId ? await savedDraft(project, input.draftId) : null;
        if (named && config.pendingRelease) throw new Problem(409, 'Nejdřív dokončete publikování.');
        if (named?.hasContent && !process.env.SITETILLER_CMS_ROOT)
          throw Error('Pro úplné obnovení připojte Editor obsahu.');
        if (named && named.commit !== input.commit) throw new Problem(409, 'Uložený návrh se neshoduje.');
        const deleting = input.deleteStepId ? deleteStepTarget(config, input.deleteStepId, input.expectedHead) : null;
        if (deleting && deleting.commit !== input.commit) throw new Problem(409, 'Předchozí krok se neshoduje.');
        const publication = config.releases.some((release: any) => release.commit === input.commit),
          step = config.requests.some(
            (request: any) => request.commit === input.commit && ['ready', 'legacy'].includes(request.status),
          );
        if (!publication && !step && !named && !deleting) throw Error('Vybraná verze není dostupná.');
        if (!process.env.SITETILLER_CMS_ROOT) return response(res, 200, { hasContent: false });
        const source = publication && config.separatedHistories ? productionProject()! : project;
        const content = await restoredContent(source, input.commit),
          state = await restoreContentState();
        await applyRestoredContent(content, state.revision, true);
        return response(res, 200, {
          hasContent: true,
          revision: state.revision,
          collections: Object.keys(content.collections).length,
          files: content.assets.length,
        });
      }
      if (path === '/api/restore' && req.method === 'POST') {
        await syncProduction(config);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const input = await body(req);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const mode = input.historyMode || 'keep';
        if (input.deleteStepId && mode !== 'rewind')
          throw Error('Odstranění posledního kroku vyžaduje návrat na předchozí krok.');
        if (!['keep', 'clear-all', 'rewind'].includes(mode)) throw new Problem(422, 'Neplatná volba historie úprav.');
        claim();
        try {
          const named = input.draftId ? await savedDraft(project, input.draftId) : null;
          if (named?.hasContent && !process.env.SITETILLER_CMS_ROOT)
            throw Error('Pro úplné obnovení připojte Editor obsahu.');
          if (named && named.commit !== input.commit) throw new Problem(409, 'Uložený návrh se neshoduje.');
          const previousHead = await project.head(),
            previousPresentation = presentationState(config, previousHead);
          if (input.expectedHead !== previousHead) throw new Problem(409, 'Návrh se mezitím změnil.');
          const publishedContent =
            config.separatedHistories && config.releases.some((release: any) => release.commit === input.commit);
          const contentSource = publishedContent ? productionProject()! : project;
          let content: any = null;
          if (process.env.SITETILLER_CMS_ROOT) {
            if (input.confirmContentRestore !== true || typeof input.contentRevision !== 'string')
              throw new Problem(422, 'Potvrďte také obnovení struktury, pracovního obsahu a souborů.');
            content = await restoredContent(contentSource, input.commit);
            await applyRestoredContent(content, input.contentRevision, true);
          }
          const finishContentRestore = async (commit: string) => {
            if (!content) return;
            try {
              await applyRestoredContent(content, input.contentRevision, false);
            } catch (error) {
              if ((await project.head()) === commit) await project.git(['reset', '--hard', previousHead]);
              throw error;
            }
          };
          if (mode === 'rewind') {
            const deleting = input.deleteStepId
              ? deleteStepTarget(config, input.deleteStepId, input.expectedHead)
              : null;
            if (deleting && deleting.commit !== input.commit) throw new Problem(409, 'Předchozí krok se neshoduje.');
            const selected =
              deleting ||
              config.requests.findLast(
                (r: any) =>
                  r.commit === input.commit &&
                  (!input.stepId || r.id === input.stepId) &&
                  ['ready', 'legacy'].includes(r.status),
              );
            if (!selected) throw new Problem(409, 'Vybraný krok již není v rozpracovaných úpravách.');
            const result = await project.rewind(
              input.commit,
              input.expectedHead,
              config.separatedHistories ? null : config.publishedCommit || null,
            );
            await finishContentRestore(result.commit);
            config.requestSequence = Math.max(
              config.requestSequence || 0,
              ...config.requests.map((r: any) => r.sequence || 0),
            );
            config.requests = config.requests.filter((r: any) => r.sequence <= selected.sequence);
            delete config.presentationHead;
            delete config.presentationStepId;
            const display = presentationState(config, result.commit);
            config.presentationHead = display.presentationHead;
            config.presentationStepId = display.presentationStepId;
            config.pendingRelease = null;
            config.approvedCommit = null;
            config.technicalApproval = null;
            config.reviewedThrough = Math.min(config.reviewedThrough || 0, selected.sequence);
            config.lastReviewCommit =
              config.publishedCommit || (await project.git(['rev-list', '--max-parents=0', 'HEAD']));
            await save('config.json', config);
            await eventWrites;
            const ids = new Set(config.requests.map((r: any) => r.id)),
              commits = new Set(config.requests.map((r: any) => r.commit));
            events = events.filter(
              (e) => e.stage === 'published' || ids.has(e.jobId) || (e.kind === 'restore' && commits.has(e.commit)),
            );
            await save('events.json', events);
            job = null;
            await save('last-job.json', job);
            historyCache = null;
            return response(res, 200, { ...result, rewound: true });
          }
          if (
            mode === 'clear-all' &&
            !named &&
            !config.releases.some((r: any) => r.id === input.releaseId && r.commit === input.commit) &&
            !config.requests.some(
              (r: any) =>
                r.commit === input.commit &&
                (!input.stepId || input.stepId === r.id) &&
                ['ready', 'legacy'].includes(r.status),
            )
          )
            throw new Problem(409, 'Vybraný krok nebo verze již nejsou dostupné.');
          const head = await project.head();
          if (input.expectedHead !== head) throw new Problem(409, 'Návrh se mezitím změnil. Obnov seznam úprav.');
          const isPublished = config.separatedHistories && config.releases.some((r) => r.commit === input.commit);
          const result =
            mode === 'clear-all'
              ? {
                  commit: (
                    await rebaseWorkspace(project, isPublished ? productionProject()! : project, input.commit, head, [])
                  ).head,
                  restoredFrom: input.commit,
                }
              : isPublished || named
                ? await restoreProduction(
                    project,
                    isPublished ? productionProject()! : project,
                    input.commit,
                    input.expectedHead,
                  )
                : await project.restore(input.commit, input.expectedHead);
          await finishContentRestore(result.commit);
          config.approvedCommit = null;
          config.technicalApproval = null;
          if (mode === 'clear-all') {
            clearDraftHistory(config, result.commit);
            config.conversationMemory = [];
            await eventWrites;
            events = [];
            await save('events.json', events);
            historyCache = null;
          }
          const changes: any = await loadedStepChanges(config, project, previousHead, result.commit);
          const loadedRequest = addRequest(config, {
            ...changes,
            id: randomBytes(8).toString('hex'),
            createdAt: new Date().toISOString(),
            prompt:
              'Načíst do úprav přesný stav webu z verze ' +
              input.commit +
              '. Tento návrat nahrazuje dřívější změny, které v této verzi nejsou.',
            restoredFrom: input.commit,
            commit: result.commit,
            status: 'ready',
            ...(named ? { savedDraftId: named.id, savedDraftName: named.name } : {}),
          });
          config.presentationHead = changes.presentationChanged ? result.commit : previousPresentation.presentationHead;
          config.presentationStepId = changes.presentationChanged
            ? loadedRequest.id
            : previousPresentation.presentationStepId;
          await save('config.json', config);
          job = { id: loadedRequest.id, kind: 'restore', status: 'ready', ...result, review: null };
          await save('last-job.json', job);
          await emit({
            stage: 'restored',
            message: 'Do úprav načtena verze ' + input.commit.slice(0, 8) + '. Publikovaný web se nezměnil.',
            commit: result.commit,
          });
          return response(res, 200, { ...result, reviewed: false, clearedPrevious: mode === 'clear-all' });
        } finally {
          busy = false;
        }
      }
      if (path === '/api/publish' && req.method === 'POST') {
        await synchronizeHistory();
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        if (config.pendingRelease?.confirmedRelease) {
          await internalPublicationFinish();
          if (config.pendingRelease?.confirmedRelease) throw new Problem(409, 'Publikování se interně dokončuje.');
        }
        const input = await body(req);
        if (busy) throw new Problem(409, 'Počkej na dokončení úlohy.');
        const frozenPublication = input.cmsSource === 'snapshot' || input.commit !== input.expectedHead;
        const publishCmsSource = frozenPublication ? 'unpublished' : designContentMode(input.cmsSource ?? 'published');
        if (publishCmsSource === 'unpublished' && input.confirmCmsPublication !== true)
          throw new Problem(
            422,
            'Potvrďte současné publikování nepublikovaného obsahu. Pro publikování jen designu přepněte na Publikovaný obsah.',
          );
        if (
          (input.createSubversion !== undefined && typeof input.createSubversion !== 'boolean') ||
          (input.clearPrevious !== undefined && typeof input.clearPrevious !== 'boolean')
        )
          throw new Problem(422, 'Neplatná volba publikování.');
        // External presentation: someone else changed the website Git since the last write (documentation 7.7).
        if (input.overrideWebsite !== true && (await websiteForeign()))
          throw Object.assign(new Problem(409, 'Web na hostingu mezitím změnil někdo jiný.'), { websiteForeign: true });
        if (
          input.createSubversion &&
          (!config.releases.at(-1) ||
            config.releases.at(-1).legacy ||
            input.expectedReleaseId !== config.releases.at(-1).id ||
            input.expectedPublishedCommit !== config.publishedCommit)
        )
          throw new Problem(409, 'Aktuální publikovaná verze se změnila. Obnovte seznam verzí.');
        if (
          input.description !== undefined &&
          (typeof input.description !== 'string' || input.description.length > 2000)
        )
          throw new Problem(422, 'Popis verze může mít nejvýše 2000 znaků.');
        claim();
        try {
          await prepareWorkspacePublication(project, input.commit);
          const publishId = randomBytes(8).toString('hex');
          const evidence = await publicationEvidence(project, data, publishId, config, events);
          let confirmedRelease: any = null,
            beforeClose: any = null,
            publicationPending: any = null,
            ownedHead = evidence.head,
            publishRequested = false,
            provenNotCommitted = false;
          if (process.env.SITETILLER_CMS_ROOT && !frozenPublication) {
            const checked = await publicationTarget(project, config, input.commit, input.expectedHead, input.stepId);
            try {
              const source =
                publishCmsSource === 'published'
                  ? await publishedRoot()
                  : { root: process.env.SITETILLER_CMS_ROOT, native: true };
              const captured = await capturePublicationSource(
                project,
                input.commit,
                checked.head,
                source.root,
                !source.native,
              );
              if (Object.keys(captured.mapping).length) {
                mapCleanupHistory(config, events, captured.mapping);
                input.commit = captured.commit;
                input.expectedHead = captured.head;
                ownedHead = captured.head;
                historyCache = null;
                await save('config.json', config);
                await eventWrites;
                await save('events.json', events);
              }
            } finally {
            }
          }
          const target = await publicationTarget(project, config, input.commit, input.expectedHead, input.stepId);
          if (!process.env.SITETILLER_PUBLISH_URL) throw new Error('Produkční Git zatím není připojen.');
          busy = true;
          job = { id: publishId, kind: 'publish', status: 'running' };
          await save('last-job.json', job);
          await emit({
            stage: 'publish',
            status: 'running',
            message: 'Provádím technickou kontrolu před publikováním.',
          });
          try {
            config.approvedCommit = null;
            config.technicalApproval = null;
            await save('config.json', config);
            const restored = config.requests.findLast((r: any) => r.commit === input.commit && r.restoredFrom);
            // An assistant's publication follows its MCP limits (documentation 2.8); the button is always strict.
            const level = checkLevel(input.checks);
            let tests = await checkPublication(
              project,
              input.commit,
              restored?.restoredFrom,
              undefined,
              target.head,
              restorationSource(config, restored?.restoredFrom, productionProject(), project),
              level,
            );
            await emit({ stage: 'publish', status: 'running', message: 'Uklízím nepoužívané a totožné obrázky.' });
            const cleaned = await cleanupPublication(project, input.commit, target.head, undefined, level);
            if (cleaned.commit !== input.commit) {
              mapCleanupHistory(config, events, cleaned.mapping);
              input.commit = cleaned.commit;
              target.head = cleaned.head;
              ownedHead = cleaned.head;
              tests = cleaned.tests!;
              historyCache = null;
              await save('config.json', config);
              await eventWrites;
              await save('events.json', events);
            }
            job = {
              ...job,
              tests,
              cleanup: { removed: cleaned.cleanup.removed, duplicates: cleaned.cleanup.duplicates },
            };
            if (cleaned.cleanup.retainedForDynamicReferences)
              await emit({
                stage: 'publish',
                status: 'warning',
                warnings: ['Obrázky s nejasnými dynamickými odkazy byly zachovány.'],
              });
            // Compatibility with the independent publisher: controller authorization is now technical, not an AI verdict.
            config.approvedCommit = input.commit;
            config.technicalApproval = {
              commit: input.commit,
              head: target.head,
              checkedAt: new Date().toISOString(),
              checks: level,
              tests,
            };
            await save('config.json', config);
            await emit({
              stage: 'publish',
              status: 'running',
              message: 'Technické kontroly prošly. Nasazuji vybranou verzi.',
            });
            config.pendingRelease = publicationIntent(
              config.releases,
              config.pendingRelease || null,
              input.commit,
              input.description?.trim(),
              publicationSummary(config.requests.filter((r: any) => r.sequence <= target.through)),
              input.createSubversion === true,
            );
            config.pendingRelease.through = target.through;
            config.pendingRelease.clearPrevious = input.clearPrevious !== false;
            config.pendingRelease.workspacePlan = await prepareWorkspacePublication(project, input.commit);
            config.pendingRelease.evidence = evidence;
            publicationPending = structuredClone(config.pendingRelease);
            await save('config.json', config);
            publishRequested = true;
            const result = await fetch(process.env.SITETILLER_PUBLISH_URL!, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + process.env.SITETILLER_PUBLISH_TOKEN,
              },
              body: JSON.stringify({ commit: input.commit, overrideWebsite: input.overrideWebsite === true }),
              signal: AbortSignal.timeout(180000),
            });
            if (!result.ok) {
              const failure: any = await result.json().catch(() => ({}));
              provenNotCommitted = failure.committed === false;
              throw new Error(failure.error || 'Publikační služba nepotvrdila nasazení.');
            }
            const confirmation: any = await result.json();
            if (confirmation.pending && confirmation.committed) {
              config.pendingRelease.publisherCommitted = true;
              await confirmedPublicationEvidence(data, config.pendingRelease);
              await save('config.json', config);
              job = { ...job, status: 'running', published: false, committed: true };
              await save('last-job.json', job);
              return response(res, 202, { ok: true, publishing: true, committed: true });
            }
            if (confirmation.ok !== true || confirmation.commit !== input.commit)
              throw new Error('Publikační služba potvrdila jinou verzi.');
            if (config.separatedHistories) {
              if (!confirmation.release || confirmation.release.sourceCommit !== input.commit)
                throw Error('Chybí potvrzení publikované verze.');
              confirmedRelease = confirmation.release;
              config.pendingRelease.confirmedRelease = confirmedRelease;
              config.pendingRelease.confirmedAt = new Date().toISOString();
              config.pendingRelease.evidence = evidence;
              publicationPending = structuredClone(config.pendingRelease);
              await confirmedPublicationEvidence(data, config.pendingRelease);
              await save('config.json', config);
            }
            if (config.separatedHistories) {
              const finished = await finishConfirmedPublication(project, data, config, events, job);
              config = finished.config;
              events = finished.events;
              job = finished.job;
              historyCache = null;
              return response(res, 200, {
                ok: true,
                published: true,
                cleanupPending: false,
                release: confirmedRelease,
              });
            }
            const completed = await completePublication(project, config.releases, config.pendingRelease);
            config.releases = completed.releases;
            config.pendingRelease = null;
            config.publishedCommit = input.commit;
            config.draftBaseCommit = input.commit;
            config.reviewedThrough = target.through;
            config.lastReviewCommit = input.commit;
            publicationClosing(config, input.commit, target.through, input.clearPrevious !== false);
            config.publishedThrough = target.through;
            events = closePublishedHistory(config, events).events;
            await save('events.json', events);
            await save('config.json', config);
            job = { ...job, status: 'ready', published: true, commit: input.commit };
            await save('last-job.json', job);
            return response(res, 200, { ok: true, published: true, release: completed.release });
          } catch (e: any) {
            if (!confirmedRelease && config.pendingRelease) {
              const observed = structuredClone(config);
              try {
                await syncProduction(observed);
                confirmedRelease = observed.releases?.find(
                  (r: any) =>
                    r.sourceCommit === config.pendingRelease.commit &&
                    r.number === config.pendingRelease.number &&
                    (r.minor ?? null) === (config.pendingRelease.minor ?? null),
                );
              } catch {}
            }
            if (confirmedRelease) {
              const persisted = await load('config.json', {}).catch(() => ({})),
                closedAlready =
                  persisted.pendingRelease === null &&
                  persisted.draftBaseCommit === confirmedRelease.commit &&
                  persisted.publishedThrough >= target.through;
              if (closedAlready) {
                config = persisted;
                job = {
                  ...job,
                  status: 'ready',
                  published: true,
                  cleanupPending: false,
                  release: confirmedRelease,
                  commit: confirmedRelease.commit,
                };
                await save('last-job.json', job).catch(() => {});
                return response(res, 200, {
                  ok: true,
                  published: true,
                  cleanupPending: false,
                  release: confirmedRelease,
                });
              }
              if (beforeClose) {
                config = beforeClose.config;
                events = beforeClose.events;
                await eventWrites.catch(() => {});
                await save('events.json', events).catch(() => {});
              }
              config.approvedCommit = null;
              config.technicalApproval = null;
              config.pendingRelease = {
                ...(config.pendingRelease || publicationPending),
                confirmedRelease,
                evidence,
                cleanupPending: true,
              };
              const recoverySaved = await confirmedPublicationEvidence(data, config.pendingRelease).then(
                () => true,
                () => false,
              );
              await save('config.json', config).catch(() => {});
              const warning =
                'Verze ' +
                confirmedRelease.number +
                (confirmedRelease.minor !== undefined ? '.' + confirmedRelease.minor : '') +
                ' byla publikována. Systém interně dokončuje její záznam.';
              job = {
                ...job,
                status: 'ready',
                published: true,
                cleanupPending: true,
                release: confirmedRelease,
                warning,
              };
              await save('last-job.json', job).catch(() => {});
              await emit({
                stage: 'published',
                status: 'warning',
                message: warning,
                commit: confirmedRelease.commit,
                release: confirmedRelease,
                kind: 'publish',
              }).catch(() => {});
              return response(res, 200, {
                ok: true,
                published: true,
                cleanupPending: true,
                recoverySaved,
                release: confirmedRelease,
                warning,
              });
            }
            let status: any = null;
            try {
              status = await observePublisher();
            } catch {}
            if (status?.committed || (publishRequested && !provenNotCommitted)) {
              config.pendingRelease.publisherCommitted = !!status?.committed;
              config.pendingRelease.publisherUnknown = !status?.committed;
              await confirmedPublicationEvidence(data, config.pendingRelease);
              await save('config.json', config);
              job = { ...job, status: 'running', committed: true };
              await save('last-job.json', job);
              return response(res, 202, { ok: true, publishing: true, committed: true });
            }
            const previous = JSON.parse(await readFile(join(evidence.directory, 'before.json'), 'utf8'));
            const preparedHead = await project.head();
            if (
              preparedHead !== ownedHead ||
              (await project.git(['status', '--porcelain', '--untracked-files=no'])) ||
              (await project.git(['status', '--porcelain', '--', 'site']))
            )
              throw new Problem(409, 'Pracovní stav se během publikování změnil; zůstává zachovaný.');
            await project.git(['read-tree', '--reset', '-u', previous.head]);
            await project.git(['update-ref', 'HEAD', previous.head, preparedHead]);
            config = previous.config;
            events = previous.events;
            await save('events.json', events);
            await save('config.json', config);
            job = {
              ...job,
              status: 'failed',
              error:
                e.name === 'TimeoutError'
                  ? 'Publikování se nepodařilo ověřit. Návrh je zachovaný; výsledek ověřuje systém.'
                  : e.message,
            };
            await save('last-job.json', job);
            await emit({ stage: 'failed', message: job.error });
            throw Error(job.error);
          } finally {
            busy = false;
          }
        } finally {
          busy = false;
        }
      }
      return response(res, 404, { error: 'Nenalezeno.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return response(res, 405, { error: 'Nepovolená metoda.' });
    // The studio page is the Vite build in dist/: index.html, theme.js and content-hashed files in assets/.
    const asset = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'theme.js'].includes(asset) && !/^assets\/[\w.-]+\.(js|css)$/.test(asset))
      return response(res, 404, { error: 'Nenalezeno.' });
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self' https: " +
        previewOrigin +
        "; img-src 'self' blob: data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
    );
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let assetBody: Buffer;
    try {
      assetBody = await readFile(join(root, 'dist', asset));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return response(res, asset === 'index.html' ? 503 : 404, {
        error: asset === 'index.html' ? 'AI Studio není sestavené (npm run build).' : 'Nenalezeno.',
      });
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(asset)],
      'Cache-Control': asset.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    if (asset !== 'index.html') return res.end(assetBody);
    // The page language: the common settings when the studio runs behind the Shell, else SITETILLER_UI_LANGUAGE.
    let shared: any = null;
    if (process.env.SITETILLER_SHARED_SETTINGS_FILE) {
      try {
        shared = JSON.parse(await readFile(process.env.SITETILLER_SHARED_SETTINGS_FILE, 'utf8'));
      } catch {}
    }
    const language = shared
      ? shared.language === 'en'
        ? 'en'
        : 'cs'
      : normalizeLocale(process.env.SITETILLER_UI_LANGUAGE);
    // The colour mode of the Shared settings (documentation 2.4); theme.js applies it before the page is painted.
    const mode = shared ? colourMode(shared) : '';
    res.end(
      assetBody
        .toString()
        .replace(
          '<html lang="en">',
          '<html lang="' +
            language +
            '"' +
            (shared ? ' data-shared-language="' + language + '"' : '') +
            (mode ? ' data-mode="' + mode + '"' : '') +
            '>',
        ),
    );
  } catch (e: any) {
    response(res, e instanceof Problem ? e.status : 400, {
      error: e.message || 'Požadavek nelze dokončit.',
      ...(e?.websiteForeign ? { websiteForeign: true } : {}),
    });
  }
});
// Under the Shell's supervisor on a hidden port; the origin stays the public port (documentation 2.6).
server.listen(Number(process.env.SITETILLER_LISTEN_PORT || PORT), HOST, () =>
  console.log(`SiteTiller listening on ${HOST}:${PORT}`),
);
