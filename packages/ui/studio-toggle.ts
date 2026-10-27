import { inject } from 'vue';
// Switching between the Content editor and AI Studio (documentation 2.2): two icons side by side, the open studio
// raised (in Settings neither). Both are real links; the host follows them through the `navigate` event like the
// studio menu. The Shell renders it on the server for Settings, where the links work without a script.
const template = `<nav class="studio-toggle" :aria-label="t('switch_editor')"><a :href="contentHref" :aria-current="active==='content'?'page':undefined" :aria-label="t('content_editor')" :title="t('content_editor')" @click.prevent="$emit('navigate',contentHref)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/></svg></a><a :href="siteHref" :aria-current="active==='site'?'page':undefined" :aria-label="t('ai_studio')" :title="t('ai_studio')" @click.prevent="$emit('navigate',siteHref)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1-2-2 2 2 0 0 1-2 2zm0-12a2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1-2-2 2 2 0 0 1-2 2zM9 18a6 6 0 0 1 6-6 6 6 0 0 1-6-6 6 6 0 0 1-6 6 6 6 0 0 1 6 6z"/></svg></a></nav>`;
export default {
  template,
  props: {
    active: { type: String, default: '' },
    contentHref: { type: String, default: '/content/' },
    siteHref: { type: String, default: '/site/' },
  },
  emits: ['navigate'],
  setup() {
    return { t: inject<(key: string) => string>('translate', (key: string) => key) };
  },
};
