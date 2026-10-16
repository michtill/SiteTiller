import { reactive, ref, nextTick, onMounted } from 'vue';
import { t } from './i18n.ts';
import { s, api, notice, refresh, historicalContent } from './studio.ts';
import { dialogs } from './dialogs.ts';
// Saving the shown version as a named draft; editing continues afterwards.
const template = `<dialog id="save-draft-dialog" ref="dialog" :data-commit="d.commit" :data-head="d.head" :data-cms-source="d.cmsSource"><form id="save-draft-form" @submit.prevent="save"><h2>{{t('save_draft')}}</h2><p>{{t('save_draft_help')}}</p><label for="draft-name">{{t('draft_name')}}</label><input id="draft-name" ref="name" v-model="d.name" maxlength="120" required><label class="restore-options"><input id="save-clear-previous" type="checkbox" v-model="d.clear"><span>{{t('remove_previous_steps')}}</span></label><p id="save-draft-status" role="status">{{d.status}}</p><div class="confirm-actions"><button id="cancel-save-draft" type="button" @click="dialog.close()">{{t('back')}}</button><button id="confirm-save-draft" type="submit" class="primary" :disabled="d.saving">{{t('save_draft')}}</button></div></form></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null),
      name = ref<HTMLInputElement | null>(null);
    const d = reactive({ name: '', status: '', saving: false, commit: '', head: '', cmsSource: '', clear: true });
    async function open() {
      const selection = s.displayedSelection;
      if (s.previewPending || !selection) return;
      Object.assign(d, {
        name: '',
        status: '',
        clear: true,
        commit: selection.commit,
        head: s.current.head,
        cmsSource: !historicalContent() && s.current.cmsPreviewSources?.[selection.cmsMode!] ? selection.cmsMode : '',
      });
      dialog.value!.showModal();
      await nextTick();
      name.value?.focus();
    }
    onMounted(() => {
      dialogs.saveDraft = () => void open();
    });
    async function save() {
      d.saving = true;
      try {
        await api('drafts/save', {
          name: d.name,
          expectedHead: d.head,
          commit: d.commit,
          cmsSource: d.cmsSource || undefined,
          clearPrevious: d.clear,
        });
        dialog.value!.close();
        notice(t('draft_saved_continuation'));
        await refresh();
      } catch (error: any) {
        d.status = error.message;
      } finally {
        d.saving = false;
      }
    }
    return { t, dialog, name, d, save };
  },
};
