// Eye of a preview selector: crossed out (idle), open (shown) or a spinner while the preview loads.
const paths: Record<string, string[]> = {
  loading: ['M12 3a9 9 0 1 1-9 9'],
  selected: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  idle: [
    'M3 3l18 18',
    'M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.2 4.1',
    'M6.3 6.3A19 19 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.4',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
};
const template = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" :data-selection-icon="state" :class="{'preview-spinner':state==='loading'}"><path v-for="d in paths[state]" :key="d" :d="d"/></svg>`;
export default {
  template,
  props: { state: { type: String, default: 'idle' } },
  setup() {
    return { paths };
  },
};
