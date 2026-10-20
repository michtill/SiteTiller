import { computed } from 'vue';
import { t } from './i18n.ts';
import { s, selectorState, eyeTarget, eyeLabel } from './studio.ts';
import EyeIcon from './eye-icon.ts';
// One block of the conversation; a finished step with a preview can be shown by clicking it.
const template = `<article class="progress-group" :class="{'result-complete':block.successful||block.selectable,'step-selectable':block.selectable,'preview-active':pressed}" :data-group-id="block.id" :data-commit="block.commit||undefined" :data-content-only="block.contentOnly?'true':undefined" :data-current-draft="block.currentDraft" :data-collapsible-discussion="block.isEdit?String(block.collapsible):undefined" @click="selectBlock">
<small v-if="block.contentOnly" class="content-step-note">{{t('content_step_without_preview')}}</small>
<div v-if="block.badges.length" class="step-badges"><span v-for="badge in block.badges" class="step-badge" :data-badge="badge.kind">{{badge.text}}</span></div>
<div v-if="block.isPublication" class="user-message"><div class="chat-request"><p class="request-text">{{block.publicationPrompt}}</p></div></div>
<h3 v-if="block.title" class="first-step-title">{{block.title}}</h3><div v-if="block.prompt" class="user-message" v-bind="hit" @click="hitClick" @keydown="hitKey"><div class="chat-request"><p class="request-text">{{block.prompt}}</p></div><div v-if="block.images.length" class="request-images"><template v-for="item in block.images"><img v-if="item.isImage" :src="item.src" :alt="item.name||t('attached_image')"><template v-else><span class="attachment-file-name">{{item.name}}</span><img hidden></template></template></div></div>
<div class="chat-answer" v-bind="hit" @click="hitClick" @keydown="hitKey"><div class="status-line" :class="{'result-preview-row':block.successful}">
<p v-if="block.mode==='result'" class="response-text">{{block.summaryText}}</p>
<details v-else class="progress-row" :class="{working:block.row.running,failed:block.row.error,completed:block.done,'live-progress':block.mode==='live'}" :data-key="block.row.key" :open="block.mode==='live'||undefined"><summary :hidden="block.mode==='live'||undefined" :class="{'response-disclosure':block.mode==='disclosure'}"><span class="summary-label">{{block.mode==='disclosure'?block.summaryText:block.row.label}}<span v-if="block.row.running" class="busy-dots" :aria-label="t('working')">…</span></span><span class="disclosure-arrow" aria-hidden="true" :title="block.mode==='disclosure'?t('show_progress'):undefined">{{block.mode==='disclosure'?'…':'&gt;'}}</span></summary><div class="progress-detail"><template v-for="section in block.sections"><h3>{{section.heading}}<span v-if="section.model" class="meta actor-label">{{section.model}}</span><span v-if="section.running" class="busy-dots" :aria-label="t('working')">…</span></h3><template v-for="item in section.items"><code v-if="item.kind==='code'">{{item.text}}</code><p v-else :class="item.kind==='issue'?'issue':undefined">{{item.text}}</p></template></template></div></details>
<button v-if="block.eye" type="button" class="show-version" :class="{'preview-pending':state.busy}" :data-commit="block.eye.commit" :data-step-id="block.eye.stepId||undefined" :data-release-id="block.eye.releaseId||undefined" :aria-pressed="String(state.active)" :aria-busy="state.busy?'true':undefined" :aria-label="label" :title="label" @click.stop="eyeTarget(block.eye)"><EyeIcon :state="state.busy?'loading':state.active?'selected':'idle'"/></button>
</div><p v-if="block.response" class="response-text">{{block.response}}</p></div>
</article>`;
export default {
  template,
  props: { block: { type: Object, required: true } },
  components: { EyeIcon },
  setup(props: any) {
    const state = computed(() => {
      const eye = props.block.eye;
      if (!eye) return { busy: false, active: false };
      return selectorState(eye.releaseId ? 'release' : 'step', eye.releaseId || eye.stepId || null, eye.commit);
    });
    const pressed = computed(() => state.value.active);
    const label = computed(() => (props.block.eye ? eyeLabel(props.block.eye) : ''));
    const hit = computed(() =>
      props.block.successful
        ? { class: 'preview-hit', tabindex: 0, role: 'button', 'aria-label': t('preview_this_step') }
        : {},
    );
    const interactive = (event: Event, extra = '') =>
      !!(event.target as HTMLElement).closest('button,a,input,select,textarea' + extra) ||
      !!window.getSelection()?.toString();
    function toggle() {
      if (props.block.eye) eyeTarget(props.block.eye);
    }
    function hitClick(event: MouseEvent) {
      if (!props.block.successful || interactive(event)) return;
      event.stopPropagation();
      toggle();
    }
    function hitKey(event: KeyboardEvent) {
      if (
        props.block.successful &&
        event.target === event.currentTarget &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault();
        toggle();
      }
    }
    function selectBlock(event: MouseEvent) {
      if (!props.block.selectable || interactive(event, ',summary')) return;
      toggle();
    }
    return { t, s, state, pressed, label, hit, hitClick, hitKey, selectBlock, eyeTarget };
  },
};
