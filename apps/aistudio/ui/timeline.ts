import { computed, ref, onBeforeUpdate, onUpdated } from 'vue';
import { t, tm } from './i18n.ts';
import { compactProgress, discussionBundles, displayMessage, releaseNumber } from './presentation.ts';
import { s, APP_BASE, displayedPresentationCommit } from './studio.ts';
import TimelineBlock from './timeline-block.ts';
// The conversation: one block per request (or publication), its progress, result and the eye that shows it.
const stageNames = (): Record<string, string> => ({
  orchestrate: t('thinking'),
  answer: t('answer'),
  design: t('design_changes'),
  build: t('website_changes'),
  image: t('image_editing'),
  escalation: t('repair'),
  verify: t('requirements_verification'),
  test: t('technical_checks'),
  review: t('review'),
  ready: t('result'),
  failed: t('result'),
  published: t('publishing_label_2'),
  publish: t('publishing_label_2'),
  restored: t('restoration'),
});
const routine = [
  'Přemýšlím.',
  'Upravuji web.',
  'Provádím větší úpravu webu.',
  'Připravuji obrázek.',
  'Ověřuji splnění zadání.',
  'Ověřuji soubory a zobrazení webu.',
];
function sections(row: any) {
  const out: any[] = [];
  for (const event of row.events) {
    if (event.stage === 'request' || (event.stage === 'ready' && !event.message && !event.commit)) continue;
    let section = out.at(-1);
    if (!section || section.stage !== event.stage) {
      section = {
        stage: event.stage,
        heading: stageNames()[event.stage] || event.stage,
        model: '',
        items: [] as any[],
      };
      out.push(section);
    }
    if (event.model && !section.model) section.model = event.model;
    if (event.message && !routine.includes(event.message))
      section.items.push({ kind: 'p', text: displayMessage(event, tm) });
    for (const issue of [
      ...(event.errors || []),
      ...(event.issues || []),
      ...(event.warnings || []).map((w: string) => t('warning') + w),
    ])
      section.items.push({ kind: 'issue', text: issue });
    for (const check of event.checks || [])
      section.items.push({
        kind: 'p',
        text:
          typeof check === 'string' ? check : (check.passed ? '✓ ' : '! ') + (check.summary || check.requestId || ''),
      });
    if (event.commit) section.items.push({ kind: 'code', text: event.commit.slice(0, 8) });
  }
  if (row.running && out.length) out.at(-1).running = true;
  return out;
}
function eyeFor(group: any) {
  const current = s.current,
    edit = ['edit', 'restore', 'restored'].includes(group.kind);
  if (
    edit &&
    group.done &&
    group.request?.presentationChanged !== false &&
    group.commit &&
    group.commit !== group.baseCommit &&
    (group.commit === current.head ||
      group.commit === (current.presentationHead || current.head) ||
      (current.requests || []).some((r: any) => r.commit === group.commit && ['ready', 'legacy'].includes(r.status)) ||
      current.history.some((h: any) => h.commit === group.commit))
  )
    return {
      commit: group.commit,
      stepId: group.request?.id || current.requests.findLast((r: any) => r.commit === group.commit)?.id,
      message: group.prompt,
    };
  if (group.done && ['publish', 'published'].includes(group.kind)) {
    const event = group.events.findLast((e: any) => e.stage === 'published'),
      release =
        current.releases.find((r: any) => r.id === event?.release?.id) ||
        current.releases.findLast((r: any) => r.commit === group.commit);
    if (release && current.history.some((h: any) => h.commit === release.commit))
      return {
        commit: release.commit,
        releaseId: release.id,
        message: release.description || release.summary || t('published_version'),
      };
  }
  return null;
}
// A step with a preview carries badges: the saved drafts made from it and the versions published from it.
function badgesFor(commit: string | undefined) {
  if (!commit) return [];
  const current = s.current;
  return [
    ...(current.savedDrafts || [])
      .filter((d: any) => (d.step || d.presentationHead) === commit)
      .map((d: any) => ({ kind: 'saved', text: t('saved_badge', { name: d.name }) })),
    ...(current.releases || [])
      .filter((r: any) => r.commit === commit || r.sourceCommit === commit)
      .map((r: any) => ({
        kind: 'published',
        // A version published before numbering has no number.
        text: r.legacy ? t('published') : t('published_badge', { version: releaseNumber(r) }),
      })),
  ];
}
function view(group: any) {
  const row = group.rows[0],
    isPublication = ['publish', 'published'].includes(group.kind),
    isEdit = ['edit', 'restore', 'restored'].includes(group.kind) || isPublication,
    eye = eyeFor(group);
  const finalEvent = group.request?.finalAnswer
    ? { stage: 'final-answer', message: group.request.finalAnswer, agentResponse: true }
    : row.events.findLast((e: any) => e.stage === 'final-answer');
  const responseEvent =
    finalEvent ||
    (row.error
      ? row.events.findLast((e: any) => e.stage === 'failed')
      : group.kind === 'edit'
        ? row.events.findLast((e: any) => ['build', 'answer'].includes(e.stage) && e.status === 'completed')
        : row.events.findLast((e: any) => ['review', 'restored', 'published'].includes(e.stage) && e.message));
  const response = !row.running && responseEvent?.message ? displayMessage(responseEvent, tm) : '';
  const summaryText =
    response || group.events.findLast((e: any) => e.message && e.stage !== 'request')?.message || t('show_progress');
  const mode = !isEdit ? 'details' : row.running ? 'live' : group.done ? 'result' : 'disclosure';
  const images = (
    group.request?.attachments ||
    group.events.find((e: any) => e.stage === 'request')?.attachments ||
    []
  ).map((item: any) => ({
    ...item,
    isImage: !!item.mime?.startsWith('image/'),
    src: APP_BASE + '/api/images/' + item.id,
  }));
  return {
    id: group.id,
    kind: group.kind,
    commit: group.commit,
    prompt: group.prompt,
    title: group.title,
    images,
    isPublication,
    isEdit,
    eye,
    badges: group.done && isEdit && group.request?.status !== 'answered' ? badgesFor(eye?.commit || group.commit) : [],
    mode,
    row,
    sections: sections(row),
    response: mode === 'details' ? response : '',
    summaryText,
    publicationPrompt: isPublication
      ? group.events.findLast((e: any) => e.stage === 'published')?.release?.minor !== undefined
        ? t('publish_a_new_subversion')
        : t('publish_a_new_version')
      : '',
    contentOnly: group.request?.presentationChanged === false && group.request.changeKind === 'content',
    currentDraft: String(
      group.done && group.request?.presentationChanged !== false && group.commit === displayedPresentationCommit(),
    ),
    successful: isEdit && !!eye && group.done,
    selectable: !isEdit && !!eye && group.done,
    done: group.done,
    collapsible:
      group.kind === 'edit' &&
      group.request?.presentationChanged !== false &&
      !eye &&
      group.rows.every((r: any) => !r.running),
  };
}
const template = `<div id="timeline" class="timeline" aria-live="polite" ref="timeline">
<div v-if="welcome" class="reality-welcome"><p>{{welcome}}</p><button type="button" :disabled="s.current.busy" @click="$emit('reality')">{{t('load_the_live_website')}}</button></div>
<template v-for="entry in entries" :key="entry.key"><details v-if="entry.archive" class="discussion-archive" :data-key="entry.key"><summary><span class="summary-label">{{entry.label}}</span><span class="disclosure-arrow" aria-hidden="true">&gt;</span></summary><div class="discussion-archive-body"><TimelineBlock v-for="block in entry.blocks" :key="block.id" :block="block"/></div></details><TimelineBlock v-else :block="entry.block"/></template>
</div>`;
export default {
  template,
  emits: ['reality'],
  components: { TimelineBlock },
  setup() {
    const timeline = ref<HTMLElement | null>(null);
    const welcome = computed(() => {
      const current = s.current;
      if (
        !current ||
        current.hasLoadedReality ||
        // The website at the address was published by SiteTiller itself: nothing to load back.
        current.releases.some((r: any) => !r.imported) ||
        (current.releases.length && (current.hasDraftSteps || current.events.length))
      )
        return '';
      return current.siteUrl
        ? t('do_you_already_have_a_website_at') + new URL(current.siteUrl).hostname + '?'
        : t('do_you_already_have_a_website');
    });
    const entries = computed(() => {
      const current = s.current;
      if (!current) return [];
      const blocks = compactProgress(
        current.events,
        current.job,
        current.busy,
        current.roles,
        current.requests || [],
      ).map(view);
      const byId = new Map(blocks.map((b) => [b.id, b])),
        archived = new Map<string, string[]>(),
        inArchive = new Set<string>();
      for (const bundle of discussionBundles(
        blocks.map((b) => ({ id: b.id, result: b.successful || b.selectable, collapsible: b.collapsible })),
      )) {
        archived.set(bundle.resultId, bundle.ids);
        for (const id of bundle.ids) inArchive.add(id);
      }
      const out: any[] = [];
      for (const block of blocks) {
        if (inArchive.has(block.id)) continue;
        const ids = archived.get(block.id);
        if (ids)
          out.push({
            key: 'discussion-before-' + block.id,
            archive: true,
            label: t('discussion_before_result', { count: ids.length }),
            blocks: ids.map((id) => byId.get(id)),
          });
        out.push({ key: block.id, block });
      }
      return out;
    });
    // A timeline scrolled to its end follows new messages; otherwise it keeps its position.
    let follow = true,
      scroll = 0;
    onBeforeUpdate(() => {
      const el = timeline.value;
      if (!el) return;
      follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      scroll = el.scrollTop;
    });
    onUpdated(() => {
      const el = timeline.value;
      if (el) el.scrollTop = follow ? el.scrollHeight : scroll;
    });
    return { t, s, timeline, welcome, entries };
  },
};
