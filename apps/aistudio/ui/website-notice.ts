import { computed } from 'vue';
import { t } from './i18n.ts';
import { s } from './studio.ts';
// External presentation (documentation 7.7): someone else changed the website Git, or the last write failed.
// Only a notice: the next publication asks in its dialog whether to publish anyway.
const template = `<div v-if="kind" id="website-notice" class="website-notice" role="status"><p>{{kind==='foreign'?t('someone_else_changed_the_website_on_the_hosting'):t('hosted_website_not_updated_next_publication_retries')}}</p></div>`;
export default {
  template,
  setup() {
    const kind = computed(() => {
      const website = s.current?.website;
      return website?.foreign ? 'foreign' : website?.error ? 'error' : '';
    });
    return { t, kind };
  },
};
