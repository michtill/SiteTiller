import { computed } from 'vue';
import { t } from './i18n.ts';
import { s, selectorState, selectSavedDraft } from './studio.ts';
import { formatDate } from './release-card.ts';
import EyeIcon from './eye-icon.ts';
// Saved drafts, newest first; a card shows the frozen draft in the preview.
const template = `<section id="saved-drafts" class="history-panel" role="tabpanel" aria-labelledby="drafts-tab"><article v-for="draft in drafts" :key="draft.id" class="publication-card publication-selectable saved-draft-card" :class="{'preview-active':state(draft).active,'preview-pending':state(draft).busy}" :data-draft-id="draft.id" tabindex="0" role="button" :aria-label="draft.name" :aria-pressed="String(state(draft).active)" :aria-busy="state(draft).busy?'true':undefined" @click="selectSavedDraft(draft)" @keydown="onKey($event,draft)"><div class="saved-draft-details"><strong>{{draft.name}}</strong><p class="meta">{{date(draft.createdAt)}}</p></div><span class="show-version selector-eye" aria-hidden="true"><EyeIcon :state="state(draft).busy?'loading':state(draft).active?'selected':'idle'"/></span></article><p v-if="!drafts.length">{{t('no_saved_drafts')}}</p></section>`;
export default {
  template,
  components: { EyeIcon },
  setup() {
    const drafts = computed(() => [...(s.current?.savedDrafts || [])].reverse());
    const state = (draft: any) => selectorState('saved', draft.id);
    function onKey(event: KeyboardEvent, draft: any) {
      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        void selectSavedDraft(draft);
      }
    }
    return { t, drafts, state, selectSavedDraft, onKey, date: formatDate };
  },
};
