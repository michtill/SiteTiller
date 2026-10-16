import { reactive, ref, watch, onMounted } from 'vue';
import { t, tm } from './i18n.ts';
import {
  s,
  api,
  notice,
  refresh,
  viewedCommit,
  historicalContent,
  resetPreviewSelection,
  selectPreviewTarget,
  selectedStepId,
} from './studio.ts';
import { dialogs } from './dialogs.ts';
// Publishing the shown version: what it includes, an optional description and, if wanted, a subversion
// of the current version. While it runs, the dialog shows the progress the server reports.
const template = `<dialog id="publish-confirm" ref="dialog" :class="{'is-publishing':d.publishing}" :aria-busy="d.publishing?'true':undefined" :data-cms-source="d.cmsSource" :data-commit="d.commit" :data-head="d.head" :data-release-id="d.releaseId" :data-published-commit="d.publishedCommit" :data-step-id="d.stepId" @cancel="cancel"><div class="eyebrow"><span>{{t('publishing')}}</span></div><h2><span>{{t('publish_this_version')}}</span></h2><p id="confirm-description">{{d.description}}</p><div id="publish-cms-warning" class="publish-cms-warning" role="alert" :hidden="!d.warning||undefined"><strong>{{d.snapshot?t('publish_includes_step_content'):t('publish_includes_unpublished_content')}}</strong><p>{{d.snapshot?t('publish_includes_step_content_help'):t('publish_includes_unpublished_content_help')}}</p></div><label for="release-description"><span>{{t('version_description_optional')}}</span></label><textarea id="release-description" v-model="d.releaseDescription" maxlength="2000" rows="3" :placeholder="t('what_does_this_version_change')"></textarea><label class="restore-options" id="replace-release-option" :hidden="!d.subversionPossible||undefined"><input id="replace-current-release" type="checkbox" v-model="d.subversion"><span><span>{{t('create_a_subversion_of_the_current_version')}}</span></span></label><p id="replace-release-note" class="hint" :hidden="!d.subversion||undefined"><span>{{t('a_new_subversion_of_the_current_version_will')}}</span></p><label class="restore-options"><input id="publish-clear-previous" type="checkbox" v-model="d.clear" :disabled="d.publishing"><span>{{t('remove_previous_steps')}}</span></label><p id="publish-result" role="status">{{d.result}}</p><div class="confirm-actions"><button id="cancel-publish" type="button" :disabled="d.publishing" @click="dialog.close()">{{t('back')}}</button><button id="confirm-publish" type="button" class="primary" :disabled="d.publishing" @click="confirm">{{d.publishing?t('publishing_in_progress'):t('publish_website')}}</button></div></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null);
    const d = reactive({
      description: '',
      warning: false,
      snapshot: false,
      releaseDescription: '',
      subversion: false,
      subversionPossible: false,
      result: '',
      publishing: false,
      cmsSource: '',
      commit: '',
      head: '',
      releaseId: '',
      publishedCommit: '',
      stepId: '',
      clear: true,
    });
    function open() {
      const current = s.current,
        selection = s.displayedSelection!,
        commit = viewedCommit(),
        snapshot = historicalContent();
      Object.assign(d, {
        description:
          commit === current.head
            ? t('the_current_draft_will_be_published_its_draft_history_will_be_closed')
            : t('this_step_will_be_published_newer_draft_changes'),
        snapshot,
        warning: snapshot || selection.cmsMode === 'unpublished',
        cmsSource: snapshot ? 'snapshot' : selection.cmsMode,
        releaseDescription: '',
        subversion: false,
        clear: true,
        subversionPossible: !!current.releases?.at(-1) && !current.releases.at(-1).legacy,
        result: '',
        commit,
        head: current.head,
        releaseId: current.releases?.at(-1)?.id || '',
        publishedCommit: current.publishedCommit || '',
        stepId: selectedStepId() || '',
      });
      dialog.value!.showModal();
    }
    onMounted(() => {
      dialogs.publish = open;
    });
    watch(
      () => s.publishProgress,
      (value) => {
        if (d.publishing && value) d.result = value;
      },
    );
    function cancel(event: Event) {
      if (d.publishing) event.preventDefault();
    }
    async function confirm() {
      try {
        d.publishing = true;
        s.publishProgress = '';
        d.result = t('checking_the_draft_then_deploying_it');
        const result = await api('publish', {
          cmsSource: d.cmsSource,
          confirmCmsPublication: d.cmsSource !== 'published',
          commit: d.commit,
          description: d.releaseDescription.trim(),
          createSubversion: d.subversion,
          expectedReleaseId: d.releaseId,
          expectedPublishedCommit: d.publishedCommit,
          expectedHead: d.head,
          stepId: d.stepId || undefined,
          clearPrevious: d.clear,
        });
        if (result.publishing) {
          dialog.value!.close();
          notice(tm('Publikování se interně dokončuje.'));
          await refresh();
          return;
        }
        const published =
          d.commit !== d.head
            ? {
                kind: 'release' as const,
                id: result.release.id,
                commit: result.release.commit,
                historical: true,
                message: result.release.description,
              }
            : null;
        if (!published) resetPreviewSelection();
        s.cmsPreviewMode = 'published';
        dialog.value!.close();
        notice(result.warning || t('the_version_was_published'));
        await refresh();
        if (published) await selectPreviewTarget(published);
      } catch (e: any) {
        await refresh();
        d.result = e.message;
      } finally {
        d.publishing = false;
      }
    }
    return { t, dialog, d, cancel, confirm };
  },
};
