import { reactive, ref, onMounted } from 'vue';
import { t } from './i18n.ts';
import { s } from './studio.ts';
import { dialogs } from './dialogs.ts';
// Sharing the shown step, saved draft or version (documentation 4.10): the links to it, to copy or revoke, and a new one.
const template = `<dialog id="share-dialog" ref="dialog"><form id="share-form" @submit.prevent="create"><h2>{{t('share_title')}}</h2><p>{{t('share_warning')}}</p><template v-if="d.shares.length"><h3>{{t('share_existing')}}</h3><table id="share-links" class="share-links"><thead><tr><th>{{t('share_link')}}</th><th>{{t('share_valid')}}</th><th></th></tr></thead><tbody><tr v-for="share in d.shares" :key="share.id" :data-share-id="share.id"><td><input class="share-url" readonly :value="share.url" :title="share.createdBy" @focus="$event.target.select()"></td><td class="share-days">{{left(share)}}</td><td class="share-row-actions"><button type="button" class="copy-share" @click="copy(share)">{{d.copied===share.id?t('share_copied'):t('share_copy')}}</button><button type="button" class="revoke-share" @click="revoke(share)">{{t('share_revoke')}}</button></td></tr></tbody></table></template><h3>{{t('share_new')}}</h3><label for="share-validity">{{t('share_validity')}}</label><select id="share-validity" v-model="d.validity"><option value="1d">{{t('share_1d')}}</option><option value="7d">{{t('share_7d')}}</option><option value="30d">{{t('share_30d')}}</option><option value="none">{{t('share_none')}}</option></select><p id="share-status" role="status">{{d.status}}</p><div class="confirm-actions"><button id="cancel-share" type="button" @click="dialog.close()">{{t('back')}}</button><button id="confirm-share" type="submit" class="primary" :disabled="d.saving">{{t('share_create')}}</button></div></form></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null);
    const d = reactive({
      validity: '30d',
      status: '',
      saving: false,
      copied: '',
      source: {} as Record<string, string>,
      shares: [] as any[],
    });
    async function call(path: string, body?: unknown) {
      const response = await fetch('/__shell/' + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || t('share_title'));
      return result;
    }
    async function load() {
      d.shares = (await call('shares?' + new URLSearchParams(d.source))).shares;
    }
    async function open() {
      const selection = s.displayedSelection;
      if (s.previewPending || !selection) return;
      Object.assign(d, {
        validity: '30d',
        status: '',
        copied: '',
        shares: [],
        source:
          selection.kind === 'saved'
            ? { kind: 'draft', draftId: selection.id }
            : selection.kind === 'release'
              ? { kind: 'release', releaseId: selection.id }
              : selection.kind === 'step' && selection.id
                ? { kind: 'step', stepId: selection.id, commit: selection.commit }
                : { kind: 'step', commit: selection.commit },
      });
      dialog.value!.showModal();
      try {
        await load();
      } catch (error: any) {
        d.status = error.message;
      }
    }
    onMounted(() => {
      dialogs.share = () => void open();
    });
    // Whole days left, rounded up; Czech counts 1 den / 2–4 dny / 5 dní.
    function left(share: any) {
      if (!share.expires) return t('share_none');
      const days = Math.max(1, Math.ceil((Date.parse(share.expires) - Date.now()) / 86400000));
      return t(days === 1 ? 'share_days_one' : days < 5 ? 'share_days_few' : 'share_days_many', { days });
    }
    async function create() {
      d.saving = true;
      d.status = '';
      try {
        await call('shares', { ...d.source, validity: d.validity });
        await load();
      } catch (error: any) {
        d.status = error.message;
      } finally {
        d.saving = false;
      }
    }
    async function copy(share: any) {
      try {
        await navigator.clipboard.writeText(share.url);
      } catch {
        const field = dialog.value!.querySelector<HTMLInputElement>('[data-share-id="' + share.id + '"] .share-url');
        field?.select();
        document.execCommand('copy');
      }
      d.copied = share.id;
    }
    async function revoke(share: any) {
      try {
        await call('shares/revoke', { id: share.id });
        await load();
      } catch (error: any) {
        d.status = error.message;
      }
    }
    return { t, dialog, d, left, create, copy, revoke };
  },
};
