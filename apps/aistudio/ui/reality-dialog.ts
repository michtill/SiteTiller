import { reactive, ref, computed, onMounted } from 'vue';
import { t } from './i18n.ts';
import { s, api, notice, refresh, viewedCommit, resetPreviewSelection } from './studio.ts';
import { dialogs } from './dialogs.ts';
// Loading the live website into the draft: first a comparison, then the user decides whether to keep the
// existing steps and whether to record the live state as a version.
const template = `<dialog id="reality-load" ref="dialog" :class="{'is-loading':d.loading}" :aria-busy="String(d.loading)" @cancel="cancel"><div class="eyebrow"><span>{{t('load_live_website')}}</span></div><h2><span>{{t('load_the_live_website_into_the_draft')}}</span></h2><label for="reality-load-address">{{t('website_address_to_load')}}</label><span class="reality-address"><input id="reality-load-address" type="url" v-model.trim="d.address" maxlength="2000" :disabled="d.loading||d.comparing"><button v-if="d.address!==d.url" id="reality-compare" type="button" :disabled="!d.address||d.comparing" @click="recompare">{{d.comparing?t('loading'):t('compare_this_address')}}</button></span><p><span>{{t('the_loaded_website_becomes_the_starting_point_for')}}</span></p><label class="restore-options" :hidden="d.liveMatchesPublished||undefined"><input id="reality-save-version" type="checkbox" v-model="d.saveVersion" :disabled="d.loading||d.liveMatchesPublished"><span><span>{{t('save_as_a_version')}}</span></span></label><label id="reality-version-option" :hidden="!d.saveVersion||undefined"><span>{{t('version_number')}}</span><input id="reality-version-number" type="number" min="0" max="999999" step="1" v-model.number="d.versionNumber" :disabled="d.loading"></label><label id="reality-clear-option" class="restore-options" :hidden="!d.canClear||undefined"><input id="reality-clear" type="checkbox" v-model="d.clear" :disabled="d.loading"><span><span>{{t('remove_existing_edits')}}</span></span></label><p id="reality-keep-note">{{keepNote}}</p><p id="reality-load-result" role="status">{{d.result}}</p><div class="confirm-actions"><button id="cancel-reality-load" type="button" :disabled="d.cancelling" @click="close">{{t('cancel')}}</button><button id="confirm-reality-load" type="button" class="primary" :disabled="d.loading||!comparisonReady" @click="confirm">{{d.loading?t('loading'):t('load_the_live_website')}}</button></div></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null);
    let comparison: any = null,
      comparing = false;
    const d = reactive({
      url: '',
      address: '',
      comparing: false,
      compared: false,
      liveMatchesPublished: false,
      saveVersion: false,
      versionNumber: 0,
      canClear: false,
      clear: false,
      result: '',
      loading: false,
      cancelling: false,
    });
    const keepNote = computed(() =>
      d.clear
        ? t('existing_editing_steps_are_removed_saved_versions_are_preserved')
        : s.current?.hasDraftSteps
          ? t('the_import_is_added_as_another_step_existing_edits_are_preserved')
          : t('the_loaded_website_will_be_ready_for_further_edits'),
    );
    const comparisonReady = computed(() => d.compared && d.address === d.url);
    async function compare(address: string) {
      const current = s.current;
      return api('reality/compare', {
        commit: viewedCommit(),
        expectedHead: current.head,
        ...(address !== current.siteUrl ? { url: address } : {}),
      });
    }
    async function prepare() {
      const current = s.current;
      // Without the published website's address the dialog opens empty for an address to load from.
      if (!current.siteUrl) {
        comparison = null;
        open('');
        return;
      }
      if (comparing) return;
      comparing = true;
      try {
        comparison = await compare(current.siteUrl);
        if (comparison.equal) notice(t('there_are_no_differences_in_the_compared_files'));
        else open(comparison.url);
      } catch (e: any) {
        notice(e.message);
      } finally {
        comparing = false;
      }
    }
    // Another address for this one load: compare it first; nothing is saved.
    async function recompare() {
      d.comparing = true;
      d.result = '';
      try {
        comparison = await compare(d.address);
        d.url = comparison.url;
        d.address = comparison.url;
        d.compared = !comparison.equal;
        d.liveMatchesPublished = !!comparison.liveMatchesPublished;
        if (comparison.equal) d.result = t('there_are_no_differences_in_the_compared_files');
      } catch (e: any) {
        d.result = e.message;
      } finally {
        d.comparing = false;
      }
    }
    function open(url: string) {
      const current = s.current;
      Object.assign(d, {
        url,
        address: url,
        compared: !!comparison,
        liveMatchesPublished: !!comparison?.liveMatchesPublished,
        saveVersion: !current.releases.length && !comparison?.liveMatchesPublished,
        versionNumber: current.releases.length ? Math.max(...current.releases.map((r: any) => r.number)) + 1 : 0,
        canClear: current.hasDraftSteps || current.events.some((e: any) => e.stage === 'published'),
        clear: false,
        result: '',
      });
      dialog.value!.showModal();
    }
    onMounted(() => {
      dialogs.reality = () => void prepare();
    });
    // During loading, Cancel stops the load on the server; the draft stays unchanged.
    async function close() {
      if (!d.loading) return dialog.value!.close();
      d.cancelling = true;
      d.result = t('cancelling_the_load');
      await api('reality/cancel', {}).catch(() => {});
    }
    function cancel(event: Event) {
      if (d.loading) {
        event.preventDefault();
        void close();
      }
    }
    async function confirm() {
      if (!comparison || d.loading || !comparisonReady.value) return;
      d.loading = true;
      d.result = t('loading_the_website_and_checking_the_draft');
      try {
        await api('reality/load', {
          token: comparison.token,
          expectedHead: comparison.head,
          clearPrevious: d.clear,
          saveVersion: d.saveVersion,
          versionNumber: Number(d.versionNumber),
        });
        if (d.clear) {
          s.attachments = [];
          s.prompt = '';
        }
        resetPreviewSelection();
        s.workspaceTab = 'edits';
        dialog.value!.close();
        await refresh();
        notice(t('the_live_website_was_loaded_into_the_draft'));
      } catch (e: any) {
        d.result = e.message;
      } finally {
        d.loading = false;
        d.cancelling = false;
      }
    }
    return { t, dialog, d, keepNote, comparisonReady, close, cancel, confirm, recompare };
  },
};
