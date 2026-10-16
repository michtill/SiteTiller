import { computed } from 'vue';
import { t } from './i18n.ts';
import { s, selectorState } from './studio.ts';
import ReleaseCard from './release-card.ts';
// Published versions, newest first; subversions are folded under the newest card of their version.
const template = `<section id="history" class="history-panel" role="tabpanel" aria-labelledby="history-toggle"><template v-for="item in items" :key="item.key"><section v-if="item.family" class="publication-family-group" :data-release-family="item.number"><ReleaseCard :release="item.head"/><details class="publication-older" :data-key="'family-'+item.number" :open="item.openOlder||undefined"><summary><span class="summary-label">{{t('subversions')}}</span><span class="disclosure-arrow" aria-hidden="true">&gt;</span></summary><ReleaseCard v-for="release in item.older" :key="release.id" :release="release" subversion/></details></section><ReleaseCard v-else :release="item.head"/></template><p v-if="!items.length">{{t('no_published_version_yet')}}</p></section>`;
export default {
  template,
  components: { ReleaseCard },
  setup() {
    const items = computed(() => {
      const all = [...(s.current?.releases || [])].reverse(),
        families = new Map<number, any>(),
        out: any[] = [];
      for (const release of all) {
        const grouped = s.current.releases.some((r: any) => r.number === release.number && r.minor !== undefined);
        if (!grouped) {
          out.push({ key: release.id, head: release });
          continue;
        }
        let family = families.get(release.number);
        if (!family) {
          family = {
            key: 'family-' + release.number,
            family: true,
            number: release.number,
            head: release,
            older: [] as any[],
            openOlder: false,
          };
          families.set(release.number, family);
          out.push(family);
        } else {
          family.older.push(release);
          if (selectorState('release', release.id).active) family.openOlder = true;
        }
      }
      return out;
    });
    return { t, items };
  },
};
