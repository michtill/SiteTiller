import { reactive, ref, computed, onMounted } from 'vue';
import { t, tm } from './i18n.ts';
import {
  s,
  api,
  notice,
  refresh,
  checkModels,
  nextCatalogRequest,
  catalogRequestCurrent,
  useSettingsOpener,
} from './studio.ts';
import { dialogs } from './dialogs.ts';
// AI settings: provider keys (never shown again once saved), the model of each team role with its reasoning
// effort, and the image models. Model lists come from the providers; a saved choice that is not in the list
// stays selectable and is marked as unconfirmed.
const roles = () =>
  ({
    primary: t('web_lead_primary_agent'),
    ui: t('ui_code_specialist_larger_implementations'),
    verify: t('verifier_independent_verification'),
    escalation: t('escalation_repeated_failure'),
  }) as Record<string, string>;
const images = () =>
  ({ precise: t('images_precise_editing'), fast: t('images_fast_generation') }) as Record<string, string>;
const providerName = (provider: string) => (provider === 'openai' ? 'OpenAI' : 'Anthropic');
const template = `<dialog id="settings" class="settings-page" ref="dialog" @close="closed"><aside class="settings-band"><div class="eyebrow">SiteTiller</div><div class="settings-site"><span class="settings-dot" aria-hidden="true"></span>{{s.current?.editorName||'SiteTiller'}}</div><button type="button" id="close-settings" class="settings-back" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>{{t('back')}}</button></aside><main class="settings-main"><form id="settings-form" class="settings-card" @submit.prevent="save"><h1>{{t('ai_settings')}}</h1><p id="model-alert" class="model-alert" role="alert" :hidden="!alerts.length||undefined">{{alerts.map(m=>tm(m)).join('\\n')}}</p><h3 class="settings-heading"><span>{{t('api_keys')}}</span></h3>
<p id="provider-network-note" class="hint">{{s.current?.networkMode==='providers'?t('provider_access_allowed'):t('provider_access_offline')}}</p>
<div id="provider-keys" class="provider-keys"><template v-if="f.open"><label v-for="provider in ['openai','anthropic']" :key="provider">{{t('api_key')+providerName(provider)+':'}}<input type="password" :id="'key-'+provider" autocomplete="new-password" v-model="f.keys[provider]" :placeholder="hasKey(provider)?t('key_configured_keep_it'):t('enter_api_key')" @input="f.touched[provider]=true;nextCatalogRequest()"><small :id="'key-status-'+provider">{{f.keys[provider].trim()?t('key_pending'):hasKey(provider)?(f.touched[provider]?t('key_kept'):t('key_encrypted')):t('key_missing')}}</small></label></template></div>
<button id="check-models" type="button" :disabled="f.checking" @click="check"><span>{{t('check_keys_and_load_models')}}</span></button><p id="key-save-hint" class="hint">{{t('model_lookup_no_save')}}</p>
<div id="role-models" class="role-models"><template v-if="f.open"><h3 class="settings-heading">{{t('team_models')}}</h3><template v-for="(title,role) in roleLabels" :key="role"><div class="model-choice"><label :for="'role-'+role">{{title}}</label><div class="model-controls"><select :id="'role-'+role" required v-model="f.roles[role].value"><option v-for="option in modelOptions(f.roles[role].value)" :key="option.value" :value="option.value">{{option.label}}</option></select><select :id="'effort-'+role" :aria-label="t('reasoning_effort')+title" v-model="f.roles[role].effort"><option value="auto">{{t('automatic')}}</option><option value="low">{{t('low_reasoning')}}</option><option value="medium">{{t('medium_reasoning')}}</option><option value="high">{{t('high_reasoning')}}</option></select></div></div><p v-if="role==='primary'" class="hint web-lead-hint">{{t('web_lead_handles_routine_edits_directly_specialists_and')}}</p></template>
<h3 class="settings-heading">{{t('image_tools')}}</h3><label v-for="(title,key) in imageLabels" :key="key">{{title}}<select :id="'image-'+key" v-model="f.images[key]"><option value="none">{{t('disabled')}}</option><option v-for="option in imageOptions(f.images[key])" :key="option.value" :value="option.value">{{option.label}}</option></select></label></template></div>
<p class="hint"><span>{{t('keys_are_never_returned_to_the_browser_leave')}}</span></p><button class="primary" type="submit" :disabled="f.saving"><span>{{t('save_settings')}}</span></button></form></main></dialog>`;
export default {
  template,
  setup() {
    const dialog = ref<HTMLDialogElement | null>(null);
    const roleLabels = roles(),
      imageLabels = images();
    const f = reactive({
      open: false,
      checking: false,
      saving: false,
      keys: { openai: '', anthropic: '' } as Record<string, string>,
      touched: { openai: false, anthropic: false } as Record<string, boolean>,
      roles: {} as Record<string, { value: string; effort: string }>,
      images: {} as Record<string, string>,
    });
    const alerts = computed(() => s.modelAlerts);
    const hasKey = (provider: string) => !!s.current?.providers.find((p: any) => p.provider === provider)?.hasKey;
    function fill() {
      const current = s.current;
      f.keys = { openai: '', anthropic: '' };
      f.touched = { openai: false, anthropic: false };
      f.roles = Object.fromEntries(
        Object.keys(roleLabels).map((role) => {
          const choice = current.roles[role];
          return [
            role,
            {
              value: choice.provider + '|' + choice.model,
              effort: choice.reasoningEffort || (role === 'escalation' ? 'high' : 'auto'),
            },
          ];
        }),
      );
      f.images = Object.fromEntries(Object.keys(imageLabels).map((key) => [key, current.imageModels[key]]));
    }
    function modelOptions(selected: string) {
      const list = (s.modelCatalog?.models || [])
        .filter((m: any) => m.usable)
        .map((m: any) => ({ value: m.provider + '|' + m.id, label: providerName(m.provider) + ' · ' + m.name }));
      if (selected && !list.some((o: any) => o.value === selected)) {
        const separator = selected.indexOf('|');
        list.push({
          value: selected,
          label:
            providerName(selected.slice(0, separator)) +
            ' · ' +
            selected.slice(separator + 1) +
            t('availability_unconfirmed'),
        });
      }
      return list;
    }
    function imageOptions(selected: string) {
      const list = (s.modelCatalog?.models || [])
        .filter((m: any) => m.provider === 'openai' && /^gpt-image-/.test(m.id))
        .map((m: any) => ({ value: m.id, label: m.name }));
      if (selected && selected !== 'none' && !list.some((o: any) => o.value === selected))
        list.push({ value: selected, label: selected + t('availability_unconfirmed') });
      return list;
    }
    const selectedRoles = () =>
      Object.fromEntries(
        Object.entries(f.roles).map(([role, choice]) => {
          const separator = choice.value.indexOf('|');
          return [
            role,
            {
              provider: choice.value.slice(0, separator),
              model: choice.value.slice(separator + 1),
              reasoningEffort: choice.effort,
            },
          ];
        }),
      );
    // Opening shows the saved choices at once and refreshes the model lists in the background.
    async function open(load = true) {
      if (s.settingsOpen) return;
      fill();
      f.open = true;
      s.settingsOpen = true;
      s.modelAlerts = [...s.availabilityIssues];
      dialog.value!.showModal();
      if (!load) return;
      await checkModels();
      if (!s.settingsOpen) return;
      s.modelAlerts = [...s.availabilityIssues, ...(s.modelCatalog?.optionalIssues || [])];
    }
    onMounted(() => {
      useSettingsOpener((load) => void open(load));
      dialogs.settings = () => void open(true);
    });
    function closed() {
      nextCatalogRequest();
      s.settingsOpen = false;
      f.open = false;
      f.keys = { openai: '', anthropic: '' };
    }
    function close() {
      dialog.value!.close();
    }
    async function check() {
      const request = nextCatalogRequest();
      f.checking = true;
      try {
        const list = await api('models', { keys: { ...f.keys } });
        if (!catalogRequestCurrent(request) || !s.settingsOpen) return;
        s.modelCatalog = list;
        s.modelAlerts = [...(list.issues || []), ...(list.optionalIssues || [])];
      } catch (e: any) {
        if (catalogRequestCurrent(request)) s.modelAlerts = [e.message];
      } finally {
        f.checking = false;
      }
    }
    async function save() {
      nextCatalogRequest();
      f.saving = true;
      try {
        const result = await api('settings', {
          keys: { ...f.keys },
          roles: selectedRoles(),
          imageModels: { ...f.images },
        });
        s.modelCatalog = result.catalog || s.modelCatalog;
        s.availabilityIssues = [];
        dialog.value!.close();
        await refresh();
        notice(
          result.optionalIssues?.length
            ? t('settings_saved_some_optional_capabilities_are_not_available_yet')
            : t('settings_saved'),
        );
      } catch (e: any) {
        s.modelAlerts = [e.message];
      } finally {
        f.saving = false;
      }
    }
    return {
      t,
      tm,
      s,
      dialog,
      f,
      alerts,
      roleLabels,
      imageLabels,
      providerName,
      hasKey,
      modelOptions,
      imageOptions,
      nextCatalogRequest,
      closed,
      close,
      check,
      save,
    };
  },
};
