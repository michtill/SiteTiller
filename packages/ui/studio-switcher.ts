import { ref, inject, onMounted, onUnmounted } from 'vue';
// One studio menu for the Content editor and AI Studio. Every entry is a real link; the host follows it
// through the `navigate` event (inside the Shell frame without reloading the other studio). Settings (all
// settings screens, AI models included) are the Shell's.
// The host provides its translation function as 'translate' (key → text).
const template = `<details class="studio-switcher" :id="menuId||undefined" ref="menu" @keydown.esc.prevent="close(true)"><summary :aria-label="name+' · '+label+' '+t('switch_editor')"><span class="studio-logo"><span class="studio-switcher-name studio-name">{{name}}</span><small>{{label}}</small></span><svg class="studio-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><nav :aria-label="t('studio_sections')"><a :href="contentHref" :aria-current="active==='content'?'page':undefined" @click.prevent="choose(contentHref)">{{t('content_editor')}}</a><a href="/site/" :aria-current="active==='site'?'page':undefined" @click.prevent="choose('/site/')">{{t('ai_studio')}}</a><hr class="studio-menu-separator" aria-hidden="true"><a id="shared-settings-link" :href="settingsHref" @click.prevent="choose(settingsHref)"><svg class="studio-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg><span>{{t('settings')}}</span></a><button id="logout" type="button" @click="choose('/logout')"><svg class="studio-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg><span>{{t('sign_out')}}</span></button></nav></details>`;
export default {
  template,
  props: {
    active: { type: String, required: true },
    name: { type: String, default: 'SiteTiller' },
    label: { type: String, required: true },
    menuId: String,
    contentHref: { type: String, default: '/content/' },
    settingsHref: { type: String, default: '/settings' },
  },
  emits: ['navigate'],
  setup(_props: any, { emit }: any) {
    const t = inject<(key: string) => string>('translate', (key: string) => key);
    const menu = ref<HTMLDetailsElement | null>(null);
    function close(focus = false) {
      if (menu.value) {
        menu.value.open = false;
        if (focus) menu.value.querySelector('summary')?.focus();
      }
    }
    function choose(path: string) {
      close();
      emit('navigate', path);
    }
    const outside = (event: PointerEvent) => {
      if (menu.value?.open && !menu.value.contains(event.target as Node)) close();
    };
    onMounted(() => document.addEventListener('pointerdown', outside));
    onUnmounted(() => document.removeEventListener('pointerdown', outside));
    return { t, menu, close, choose };
  },
};
