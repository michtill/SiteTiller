import { reactive, ref, computed, onMounted } from 'vue';
import { t } from './i18n.ts';
import {
  s,
  api,
  notice,
  refresh,
  resetPreviewSelection,
  selectedReleaseId,
  selectedSavedDraftId,
  selectedStepId,
} from './studio.ts';
import { dialogs } from './dialogs.ts';
// Loading a version, step or saved draft into the draft. Its content is checked first, so the dialog says
// how much working content would be replaced before the user confirms.
const template = `<dialog id="restore-confirm" ref="dialog" :aria-busy="d.preparing?'true':undefined" :data-commit="d.commit" :data-head="d.head" :data-release-id="d.releaseId" :data-draft-id="d.draftId" :data-step-id="d.stepId" :data-delete-step-id="d.deleteStepId" :data-content-revision="d.contentRevision" :data-has-content="String(d.hasContent)" @cancel="cancel"><div class="eyebrow"><span>{{t('load_version')}}</span></div><h2 id="restore-confirm-title">{{d.title}}</h2><p id="restore-description">{{d.description}}</p><div id="restore-content-warning" class="publish-cms-warning" role="alert" :hidden="!d.warning||undefined"><strong>{{t('restores_working_content')}}</strong><p>{{t('restore_content_help')}}</p></div><p id="restore-content-status" role="status" :class="{'is-loading':d.preparing}">{{d.status}}</p><p>{{t('the_selected_version_will_become_the_current_draft_for_further_edits')}}</p><p id="restore-history-note">{{historyNote}}</p><p>{{t('the_live_website_will_remain_unchanged')}}</p><label class="restore-options"><input id="restore-clear-previous" type="checkbox" v-model="d.clear" :disabled="!!d.deleteStepId" aria-describedby="restore-history-note"><span id="restore-clear-label">{{d.releaseId||d.draftId?t('remove_all_draft_changes'):t('delete_subsequent_changes')}}</span></label><div class="confirm-actions"><button id="cancel-restore" type="button" :disabled="s.restoring" @click="close">{{t('cancel')}}</button><button id="confirm-restore" type="button" class="primary" :disabled="d.preparing||d.unavailable||s.restoring" @click="confirm">{{d.preparing?t('loading'):d.unavailable?t('restore_unavailable'):d.label}}</button></div></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null);
    const d = reactive({
      commit: '',
      head: '',
      releaseId: '',
      draftId: '',
      stepId: '',
      deleteStepId: '',
      title: '',
      description: '',
      label: '',
      clear: true,
      warning: false,
      status: '',
      preparing: false,
      unavailable: false,
      hasContent: false,
      contentRevision: '',
    });
    const historyNote = computed(() =>
      !d.clear
        ? t('the_existing_draft_will_remain_available_in_history')
        : d.releaseId || d.draftId
          ? t('all_draft_steps_will_be_removed_publication_history_will_be_preserved')
          : t('all_subsequent_changes_will_be_deleted_the_draft_will_return_to_this_step'),
    );
    let preparation = 0;
    async function open(item: { commit: string; message: string; deleteStepId?: string }) {
      const run = ++preparation,
        current = s.current,
        releaseId = selectedReleaseId() || '',
        draftId = selectedSavedDraftId() || '';
      Object.assign(d, {
        commit: item.commit,
        head: current.head,
        releaseId,
        draftId,
        stepId: item.deleteStepId ? '' : selectedStepId() || '',
        deleteStepId: item.deleteStepId || '',
        description: t('version') + item.commit.slice(0, 8) + ' · ' + item.message,
        title: draftId
          ? t('continue_saved_draft')
          : releaseId
            ? t('load_this_version_into_the_draft')
            : t('return_to_this_step_label'),
        label: draftId
          ? t('continue_saved_draft_button')
          : releaseId && releaseId !== current.releases?.at(-1)?.id
            ? t('load_into_draft')
            : t('return_to_this_step'),
        clear: true,
        warning: !!(current.cmsPreviewSources?.published || current.cmsPreviewSources?.unpublished),
        status: t('preparing_restore_content'),
        preparing: true,
        unavailable: false,
        hasContent: false,
        contentRevision: '',
      });
      dialog.value!.showModal();
      try {
        const prepared = await api('restore/prepare', {
          commit: item.commit,
          expectedHead: d.head,
          draftId: d.draftId || undefined,
          deleteStepId: d.deleteStepId || undefined,
        });
        if (d.commit !== item.commit || run !== preparation) return;
        d.contentRevision = prepared.revision || '';
        d.hasContent = !!prepared.hasContent;
        d.warning = !!prepared.hasContent;
        d.status = prepared.hasContent
          ? t('restore_content_count', { collections: prepared.collections, files: prepared.files })
          : '';
      } catch (error: any) {
        if (run === preparation) {
          d.status = error.message;
          d.unavailable = true;
        }
      } finally {
        if (run === preparation) d.preparing = false;
      }
    }
    onMounted(() => {
      dialogs.restore = (item) => void open(item);
    });
    function close() {
      if (!s.restoring) dialog.value!.close();
    }
    function cancel(event: Event) {
      if (s.restoring) event.preventDefault();
    }
    async function confirm() {
      if (s.restoring) return;
      s.restoring = true;
      d.status = t('restoring_draft_content');
      try {
        const clear = d.clear;
        await api('restore', {
          commit: d.commit,
          expectedHead: d.head,
          releaseId: d.releaseId || undefined,
          stepId: d.stepId || undefined,
          draftId: d.draftId || undefined,
          confirmContentRestore: d.hasContent,
          contentRevision: d.contentRevision || undefined,
          deleteStepId: d.deleteStepId || undefined,
          historyMode: d.deleteStepId ? 'rewind' : clear ? (d.releaseId || d.draftId ? 'clear-all' : 'rewind') : 'keep',
        });
        if (clear) {
          s.attachments = [];
          s.prompt = '';
        }
        if (d.hasContent) s.cmsPreviewMode = 'unpublished';
        dialog.value!.close();
        resetPreviewSelection();
        s.workspaceTab = 'edits';
        notice(t('the_version_was_loaded_into_the_draft_the_live_website_is_unchanged'));
        await refresh();
      } catch (e: any) {
        notice(e.message);
      } finally {
        s.restoring = false;
        await refresh();
      }
    }
    return { t, s, dialog, d, historyNote, close, cancel, confirm };
  },
};
