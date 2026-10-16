import { computed } from 'vue';
import { t, tm, dateLocale } from './i18n.ts';
import { releaseNumber } from './presentation.ts';
import { s, selectorState, selectPreviewTarget } from './studio.ts';
import EyeIcon from './eye-icon.ts';
// A published version; when its snapshot is available, clicking the card shows it in the preview.
const template = `<article class="publication-card" :class="{'publication-subversion':subversion,'preview-active':state.active,'preview-pending':state.busy,'publication-selectable':available}" :data-release-id="release.id" :tabindex="available?0:undefined" :role="available?'button':undefined" :aria-label="available?t('preview_version')+number:undefined" :aria-pressed="available?String(state.active):undefined" :aria-busy="state.busy?'true':undefined" @click="select" @keydown="onKey"><div class="publication-head"><div class="publication-details"><strong>{{(release.legacy?t('previously_published_version'):t('version')+number)+(latest?t('current'):'')}}</strong><p class="meta">{{release.publishedAt?date(release.publishedAt):t('date_unavailable')}}</p></div><span v-if="available" class="show-version selector-eye" aria-hidden="true"><EyeIcon :state="state.busy?'loading':state.active?'selected':'idle'"/></span></div><p class="release-description">{{(release.imported?tm(release.description):release.description)||release.summary||t('no_description')}}</p><p v-if="!available">{{t('this_version_is_unavailable')}}</p></article>`;
export const formatDate = (value: string) => new Date(value).toLocaleString(dateLocale, { timeZone: 'Europe/Prague' });
export default {
  template,
  props: { release: { type: Object, required: true }, subversion: Boolean },
  components: { EyeIcon },
  setup(props: any) {
    const state = computed(() => selectorState('release', props.release.id));
    const available = computed(() => s.current.history.some((h: any) => h.commit === props.release.commit));
    // Within a version family the base release reads as X.0 next to its subversions X.1, X.2.
    const number = computed(() =>
      props.subversion && props.release.minor === undefined
        ? props.release.number + '.0'
        : releaseNumber(props.release),
    );
    const latest = computed(() => props.release.id === s.current.releases.at(-1)?.id);
    function select() {
      if (!available.value) return;
      void selectPreviewTarget({
        kind: 'release',
        id: props.release.id,
        commit: props.release.commit,
        historical: true,
        message: props.release.description || props.release.summary || t('published_version'),
      });
    }
    function onKey(event: KeyboardEvent) {
      if (available.value && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        select();
      }
    }
    return { t, tm, state, available, number, latest, select, onKey, date: formatDate };
  },
};
