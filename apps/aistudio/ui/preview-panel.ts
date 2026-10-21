import { confirmDialog } from '../../../packages/ui/confirm-dialog.js';
import { computed, ref, onMounted } from 'vue';
import { t } from './i18n.ts';
import { releaseNumber } from './presentation.ts';
import {
  s,
  api,
  notice,
  refresh,
  viewedCommit,
  historicalContent,
  readySteps,
  resetPreviewSelection,
  selectPreviewTarget,
} from './studio.ts';
import { mountPreview } from './preview.ts';
import { dialogs } from './dialogs.ts';
// The preview of the selected version with its toolbar, and below it what the version is and what can be done with it.
const template = `<section class="preview-panel"><div class="preview-toolbar"><div><span class="live-dot"></span><strong id="project-title" :title="s.projectTitleHint||undefined">{{s.projectTitle||t('website')}}</strong></div><div class="preview-actions"><button id="theme-toggle" type="button" class="icon-button quiet" :aria-label="themeLabel" :title="themeLabel" :aria-pressed="String(theme==='light')" @click="toggleTheme"><svg class="theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg><svg class="theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.7 13A9 9 0 0 1 11 3.3 9 9 0 1 0 20.7 13Z"/></svg></button><button id="refresh-preview" class="icon-button quiet" type="button" :aria-label="t('refresh_preview')" :title="t('refresh_preview_content')" @click="reload"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.34 5.66M20 12l-3.2-3.2"/></svg></button><button id="mobile" type="button" @click="s.mobile=!s.mobile">{{s.mobile?t('desktop'):t('mobile')}}</button><a id="open-preview" target="_blank" rel="noopener noreferrer" :href="s.openPreviewHref||undefined">{{t('open')}}</a><button v-if="shareAction&&!shareAction.hidden" id="share-preview" type="button" class="text-action" :disabled="shareAction.disabled" @click="run('share-preview')">{{shareAction.label}}</button><a v-if="s.current?.liveSiteUrl" id="open-live-site" class="text-action" :href="s.current.liveSiteUrl" target="_blank" rel="noopener noreferrer">{{t('live_site')}} ↗</a></div></div>
<div id="preview-frame" ref="frame" class="frame" :class="{mobile:s.mobile,'historical-preview':s.historicalPreview}"></div>
<div class="publish-bar" :class="{'preview-selection':selection&&historicalContent()}"><div><strong id="publish-status" :class="{'historical-status':selection&&historicalContent()}">{{status.title}}</strong><div v-if="selection" id="preview-content-source" class="preview-content-source" :class="{unpublished:!historicalContent()&&selection.cmsMode==='unpublished'}" :hidden="!historicalContent()&&!s.current?.cmsPreviewSources?.[selection.cmsMode]||undefined">{{historicalContent()?t('saved_draft_content'):selection.cmsMode==='published'?t('published_content'):t('unpublished_content')}}</div><p id="publish-note">{{status.note}}</p></div>
<div class="release-actions" role="group" :aria-label="t('step_actions')" :hidden="s.previewPending||!selection||undefined" :data-kind="selection?.kind" :data-selection-id="selection?selection.id||'':undefined" :data-commit="selection?.commit"><button v-for="action in actions.filter((a)=>a.id!=='share-preview')" :key="action.id" :id="action.id" type="button" :class="{primary:action.id==='publish'}" :hidden="action.hidden||undefined" :disabled="action.disabled" @click="run(action.id)">{{action.label}}</button></div></div></section>`;
export default {
  template,
  setup() {
    const frame = ref<HTMLElement | null>(null);
    onMounted(() => mountPreview(frame.value!));
    const selection = computed(() => s.displayedSelection);
    // 'light' = day (environment colours, or the light look), 'dark' = night (black); theme.js applies them.
    const theme = ref(document.documentElement.dataset.dayNight === 'day' ? 'light' : 'dark');
    const themeLabel = computed(() => t(theme.value === 'dark' ? 'switch_to_light_mode' : 'switch_to_dark_mode'));
    function toggleTheme() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      (window as any).sitetillerApplyTheme?.(theme.value === 'light');
      try {
        localStorage.setItem('sitetiller-theme', theme.value);
      } catch {}
    }
    function reload() {
      if (s.displayedSelection) void selectPreviewTarget({ ...s.displayedSelection }, true, s.previewFollowCurrent);
    }
    const status = computed(() => {
      const current = s.current,
        selection = s.displayedSelection;
      if (!selection) return { title: t('loading'), note: '' };
      const latest = current.releases?.at(-1);
      if (selection.kind === 'saved')
        return {
          title:
            t('saved_draft') +
            ' · ' +
            (current.savedDrafts.find((d: any) => d.id === selection.id)?.name || selection.message || ''),
          note: t('saved_draft_frozen_note'),
        };
      if (selection.kind === 'release') {
        const release = current.releases.find((r: any) => r.id === selection.id),
          active = selection.id === latest?.id;
        return {
          title:
            (active ? t('current_version') : t('older_version')) +
            (release && !release.legacy ? releaseNumber(release) + ' · ' : '') +
            selection.commit.slice(0, 8),
          note: active
            ? current.hasUnpublishedWork
              ? t('you_can_load_it_into_the_draft_or_discard_all_draft_changes')
              : t('there_are_no_draft_changes')
            : t('load_it_into_the_draft_or_switch_to_current_draft'),
        };
      }
      if (historicalContent())
        return {
          title: t('previous_draft_step'),
          note: t('return_to_this_step_to_continue_editing_or_switch_to_current_draft'),
        };
      return { title: t('current_draft') + ' · ' + selection.commit.slice(0, 8), note: t('not_published_yet') };
    });
    // Actions offered for the shown version, in their order; the others stay hidden.
    const actions = computed(() => {
      const ids = ['delete-preview', 'save-draft', 'restore-preview', 'share-preview', 'publish'],
        shown: any[] = [];
      const current = s.current,
        selection = s.displayedSelection;
      if (selection && current) {
        const locked = s.previewPending || current.busy || s.submitting || s.restoring;
        const add = (id: string, label: string, disabled = false) =>
          shown.push({ id, label, disabled: locked || disabled, hidden: false });
        if (selection.kind === 'saved') {
          add('restore-preview', t('continue_saved_draft_button'));
          add('delete-preview', t('delete_step'), current.versionActions !== 1);
        } else if (selection.kind === 'release') {
          const latest = selection.id === current.releases?.at(-1)?.id;
          add(
            'restore-preview',
            latest ? t('return_to_this_step') : t('load_into_draft'),
            latest && !current.hasUnpublishedWork,
          );
        } else {
          const latest = readySteps().at(-1),
            isLatest = selection.kind === 'step' && selection.id === latest?.id && selection.commit === current.head;
          // The published step that opens the draft cannot be deleted; there is nothing before it.
          const published = (current.releases || []).some((r: any) => r.commit === selection.commit);
          if (isLatest && !published) add('delete-preview', t('delete_step'), current.versionActions !== 1);
          else if (selection.kind === 'step') add('restore-preview', t('return_to_this_step'));
          add(
            'save-draft',
            selection.kind === 'step' ? t('save_step') : t('save_draft'),
            selection.commit !== current.head && current.versionActions !== 1,
          );
          add(
            'publish',
            isLatest || selection.kind === 'draft' ? t('publish') : t('publish_this_step'),
            !!current.publicationInProgress ||
              !current.publishConfigured ||
              !(current.publishableCommits || []).includes(selection.commit),
          );
        }
      }
      // Sharing is offered while the public preview is on (documentation 4.10); its button sits next to Open.
      if (selection && current?.publicPreviewUrl) {
        const publish = shown.findIndex((a) => a.id === 'publish');
        shown.splice(publish < 0 ? shown.length : publish, 0, {
          id: 'share-preview',
          label: t('share'),
          disabled: !!(s.previewPending || current.busy || s.submitting || s.restoring),
          hidden: false,
        });
      }
      for (const id of ids)
        if (!shown.some((a) => a.id === id)) shown.push({ id, label: '', disabled: true, hidden: true });
      return shown;
    });
    async function remove() {
      const selection = { ...s.displayedSelection! };
      if (selection.kind === 'saved') {
        if (
          !(await confirmDialog({
            title: t('confirm_action_2'),
            message: t('delete_saved_draft_question'),
            confirm: t('confirm'),
            cancel: t('cancel'),
          }))
        )
          return;
        try {
          await api('drafts/remove', { id: selection.id, commit: selection.commit, expectedHead: s.current.head });
          resetPreviewSelection();
          await refresh();
        } catch (error: any) {
          notice(error.message);
        }
        return;
      }
      const steps = readySteps(),
        latest = steps.at(-1),
        previous = steps.at(-2);
      if (selection.kind !== 'step' || selection.id !== latest?.id || selection.commit !== s.current.head) return;
      const commit = previous?.commit || latest.baseCommit || s.current.draftBaseCommit;
      if (commit)
        dialogs.restore({ commit, message: previous?.prompt || t('return_to_this_step'), deleteStepId: latest.id });
    }
    function run(id: string) {
      const action = actions.value.find((a) => a.id === id);
      if (s.previewPending || !s.displayedSelection || !action || action.disabled) return;
      if (id === 'publish') dialogs.publish();
      else if (id === 'save-draft') dialogs.saveDraft();
      else if (id === 'share-preview') dialogs.share();
      else if (id === 'restore-preview')
        dialogs.restore({ commit: viewedCommit(), message: t('currently_displayed_draft_version') });
      else void remove();
    }
    return {
      t,
      s,
      frame,
      selection,
      theme,
      themeLabel,
      toggleTheme,
      reload,
      status,
      actions,
      shareAction: computed(() => actions.value.find((a) => a.id === 'share-preview')),
      run,
      historicalContent,
    };
  },
};
