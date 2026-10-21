import { ref, onMounted } from 'vue';
import { t, localize } from './i18n.ts';
import { appPath } from './app-base.ts';
// Structure templates (documentation 3.9): the empty Content editor offers them, the Structure editor has them under
// "From a template…". Only templates whose codes are still free are offered; Create writes them in one step.
const template = `<section class="template-picker" :aria-label="t('tpl_start')"><h2>{{t('tpl_start')}}</h2><p class="template-help">{{t('tpl_start_help')}}</p><p v-if="loaded&&!available.length" role="status">{{t('tpl_none_left')}}</p><template v-else><label v-for="item in available" :key="item.id" class="template-option"><input type="checkbox" :value="item.id" v-model="chosen"><span>{{item.label}}</span></label><p v-if="error" class="template-error" role="alert">{{error}}</p><div v-if="!dialog" class="template-actions"><button class="primary" type="button" :disabled="busy||!chosen.length||readonly" @click="create">{{t('tpl_create')}}</button></div></template><div v-if="dialog" class="form-footer"><button type="button" @click="$emit('cancel')">{{t('cancel')}}</button><button v-if="available.length" class="primary" type="button" :disabled="busy||!chosen.length||readonly" @click="create">{{t('tpl_create')}}</button></div></section>`;
export default {
  template,
  props: { token: String, schemaRevision: String, readonly: Boolean, dialog: Boolean },
  emits: ['created', 'cancel'],
  setup(props: any, { emit }: any) {
    const available = ref<{ id: string; label: string }[]>([]),
      chosen = ref<string[]>([]),
      loaded = ref(false),
      busy = ref(false),
      error = ref('');
    onMounted(async () => {
      try {
        const response = await fetch(appPath('/api/structure-templates'), { headers: { 'X-CMS-Token': props.token } });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || t('the_operation_failed'));
        available.value = result.templates.filter((item: any) => item.available);
      } catch (e: any) {
        error.value = localize(e.message);
      } finally {
        loaded.value = true;
      }
    });
    async function create() {
      busy.value = true;
      error.value = '';
      try {
        const response = await fetch(appPath('/api/structure-templates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CMS-Token': props.token },
          body: JSON.stringify({ ids: chosen.value, schemaRevision: props.schemaRevision }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || t('the_operation_failed'));
        emit('created', result);
      } catch (e: any) {
        error.value = localize(e.message);
      } finally {
        busy.value = false;
      }
    }
    return { t, available, chosen, loaded, busy, error, create };
  },
};
