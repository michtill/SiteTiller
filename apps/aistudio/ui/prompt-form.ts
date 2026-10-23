import { computed, ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { t, teamName } from './i18n.ts';
import { s, APP_BASE, api, notice, refresh, viewedCommit, selectedSavedDraftId, renderPreview } from './studio.ts';
// The request composer: text, attached images and documents, the team with the two checks, and the content the
// draft is designed against. The choices last until the page is reloaded.
const template = `<form id="prompt-form" :inert="!s.ready||undefined" @submit.prevent="submit"><label class="sr-only" for="prompt"><span>{{t('requested_website_change')}}</span></label><textarea id="prompt" v-model="s.prompt" :placeholder="t('prompt_placeholder')" maxlength="6000" rows="4" required @keydown="enter" @paste="paste"></textarea><input id="image-files" ref="files" type="file" accept="image/png,image/jpeg,image/webp,.pdf,.txt,.doc,.docx,.xls,.xlsx,.odt,.ods,.ppt,.pptx" multiple hidden @change="chosen"><div id="attachments"><div v-for="item in s.attachments" :key="item.id" class="attachment-preview" :class="{'attachment-document':!isImage(item)}"><span v-if="!isImage(item)" class="attachment-file-name">{{item.name}}</span><img v-if="isImage(item)" :src="APP_BASE+'/api/images/'+item.id" :alt="item.name||t('attached_image')"><img v-else hidden><button type="button" class="remove-attachment" :aria-label="t('remove_image')+item.name" @click="remove(item)">×</button></div></div>
<div class="prompt-actions"><button type="button" id="add-images" :aria-label="t('add_image')" :title="t('add_image_you_can_also_paste_from_the_clipboard')" :disabled="!s.ready||s.current?.busy||s.uploading" @click="files?.click()">+</button>

<details id="team-choice" ref="teamMenu" class="request-options team-options" @keydown.esc="closeTeams"><summary :aria-label="t('team_ai')"><span id="team-choice-label">{{teamName(chosenTeam)}}</span><span aria-hidden="true">⌄</span></summary><div class="request-options-menu"><h3>{{t('team_ai')}}</h3><button v-for="team in teams" :key="team.id" type="button" :data-team="team.id" :aria-pressed="String(team.id===chosenTeam?.id)" :disabled="s.submitting||s.current?.busy" @click="chooseTeam(team.id)"><strong>{{teamName(team)}}</strong><small>{{team.roles?.primary?.model}}</small></button><label><input id="request-technical" type="checkbox" v-model="checks.technical"><span>{{t('technical_check_toggle')}}</span></label><label><input id="request-verification" type="checkbox" v-model="checks.verification"><span>{{t('verification_toggle')}}</span></label><small class="request-options-note">{{t('team_choice_note')}}</small></div></details>
<details id="cms-preview-choice" ref="contentMenu" class="request-options content-options" :class="{'is-unpublished':s.cmsPreviewMode==='unpublished'}" :hidden="!contentChoice||undefined" @toggle="contentToggled"><summary :aria-label="t('content_for_draft')" aria-controls="content-source-popover"><span>{{s.cmsPreviewMode==='published'?t('published_content'):t('unpublished_content')}}</span><span aria-hidden="true">⌄</span></summary></details>
<Teleport to="body"><div id="content-source-popover" ref="popover" class="request-options-menu content-source-popover" popover="manual" hidden><h3>{{t('content_for_draft')}}</h3><button v-for="source in ['published','unpublished']" :key="source" type="button" :data-content-source="source" :disabled="!sources[source]||s.submitting||s.current?.busy" :aria-pressed="String(source===s.cmsPreviewMode)" @click="chooseSource(source)"><strong>{{source==='published'?t('published_short'):t('unpublished_short')}}</strong><small>{{source==='published'?t('content_published_help'):t('content_unpublished_help')}}</small></button><small>{{t('content_shared_help')}}</small><select id="cms-preview-source" hidden v-model="s.cmsPreviewMode"><option value="published" :disabled="!sources.published">{{t('published_short')}}</option><option value="unpublished" :disabled="!sources.unpublished">{{t('unpublished_short')}}</option></select></div></Teleport>
<div class="submit-controls"><button v-if="running" id="stop-run" type="button" class="primary stop-run" :aria-label="t('stop_request')" :title="t('stop_request')" :disabled="stopping" @click="stop"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button><button v-else id="run" type="submit" class="primary" :aria-label="s.current?.busy?t('task_running'):t('send_request')" :title="t('send_request')" :disabled="!s.ready||s.current?.busy||s.submitting||s.uploading"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>
<div id="prompt-preview-warning" role="status" :hidden="!previewWarning||undefined">{{t('preview_not_current_draft_warning')}}</div></form>`;
export default {
  template,
  setup() {
    const files = ref<HTMLInputElement | null>(null),
      contentMenu = ref<HTMLDetailsElement | null>(null),
      popover = ref<HTMLElement | null>(null);
    const checks = reactive({ technical: true, verification: true });
    // The team of the next requests (documentation 4.2): the default team until another one is chosen; the choice
    // lasts until the page is reloaded.
    const teamMenu = ref<HTMLDetailsElement | null>(null),
      teamChoice = ref(''),
      teams = computed(() => s.current?.teams || []),
      chosenTeam = computed(
        () =>
          teams.value.find((team: any) => team.id === teamChoice.value) ||
          teams.value.find((team: any) => team.id === s.current?.defaultTeam) ||
          teams.value[0] ||
          null,
      );
    function chooseTeam(id: string) {
      teamChoice.value = id;
      if (teamMenu.value) teamMenu.value.open = false;
    }
    function closeTeams() {
      if (teamMenu.value) {
        teamMenu.value.open = false;
        teamMenu.value.querySelector('summary')?.focus();
      }
    }
    const sources = computed(() => s.current?.cmsPreviewSources || {});
    const contentChoice = computed(
      () => !!s.current && !selectedSavedDraftId() && (sources.value.published || sources.value.unpublished),
    );
    const previewWarning = computed(
      () => !!s.current && (!!selectedSavedDraftId() || viewedCommit() !== s.current.head) && !!s.prompt.trim(),
    );
    const isImage = (item: any) => !!item.mime?.startsWith('image/');
    watch(
      () => s.cmsPreviewMode,
      () => renderPreview(),
    );
    // The content choice opens as a popover above the composer, positioned next to its button.
    function position() {
      const menu = contentMenu.value,
        pop = popover.value;
      if (!menu?.open || !pop || pop.hidden) return;
      const rect = menu.querySelector('summary')!.getBoundingClientRect(),
        width = Math.min(280, innerWidth - 16);
      pop.style.width = width + 'px';
      pop.style.maxHeight = Math.max(0, innerHeight - 16) + 'px';
      const height = pop.getBoundingClientRect().height,
        left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)),
        top = Math.max(
          8,
          Math.min(rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8, innerHeight - height - 8),
        );
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }
    function closeContent(focus = false) {
      const menu = contentMenu.value,
        pop = popover.value;
      if (menu) menu.open = false;
      if (pop) {
        if (pop.matches(':popover-open')) pop.hidePopover();
        pop.hidden = true;
      }
      if (focus) menu?.querySelector('summary')?.focus();
    }
    function contentToggled() {
      const menu = contentMenu.value,
        pop = popover.value;
      if (!menu || !pop) return;
      if (menu.open) {
        pop.hidden = false;
        if (pop.showPopover && !pop.matches(':popover-open')) pop.showPopover();
        position();
        (pop.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
      } else closeContent();
    }
    function chooseSource(source: string) {
      if (s.submitting || s.current?.busy) return;
      s.cmsPreviewMode = source;
      closeContent(true);
    }
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (teamMenu.value?.open && !teamMenu.value.contains(target)) teamMenu.value.open = false;
      if (contentMenu.value?.open && !contentMenu.value.contains(target) && !popover.value?.contains(target))
        closeContent();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && contentMenu.value?.open) {
        event.preventDefault();
        closeContent(true);
      }
    };
    const blur = () => {
      if (contentMenu.value?.open && document.activeElement?.tagName === 'IFRAME') closeContent();
      // A click into the preview (an iframe) closes the team choice too.
      if (teamMenu.value?.open && document.activeElement?.tagName === 'IFRAME') teamMenu.value.open = false;
    };
    let observer: ResizeObserver | null = null;
    onMounted(() => {
      document.addEventListener('pointerdown', outside);
      document.addEventListener('click', outside);
      document.addEventListener('keydown', escape);
      window.addEventListener('blur', blur);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
      observer = new ResizeObserver(position);
      const workspace = document.getElementById('workspace');
      if (workspace) {
        observer.observe(workspace);
        const aside = workspace.querySelector('aside');
        if (aside) observer.observe(aside);
      }
    });
    onUnmounted(() => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      observer?.disconnect();
    });
    async function upload(list: File[]) {
      if (s.uploading || s.current?.busy) return;
      s.uploading = true;
      try {
        for (const file of list) {
          if (s.attachments.length >= 4) throw Error(t('attach_up_to_four_images'));
          if (file.size > 5 * 1024 * 1024) throw Error(t('an_image_must_not_exceed_5_mb'));
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const item = await api('images', { name: file.name, data });
          if (!s.attachments.some((i) => i.id === item.id)) s.attachments.push({ ...item, use: 'auto' });
        }
      } catch (e: any) {
        notice(e.message);
      } finally {
        s.uploading = false;
      }
    }
    async function chosen() {
      const input = files.value!;
      await upload(Array.from(input.files || []));
      input.value = '';
    }
    function paste(event: ClipboardEvent) {
      const list = Array.from(event.clipboardData?.items || [])
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter(Boolean) as File[];
      if (list.length) {
        event.preventDefault();
        void upload(list);
      }
    }
    function remove(item: any) {
      s.attachments = s.attachments.filter((i) => i !== item);
    }
    function enter(event: KeyboardEvent) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        (event.target as HTMLTextAreaElement).form?.requestSubmit();
      }
    }
    // A running edit request can be stopped; the button stays disabled until the request ends.
    const running = computed(() => s.current?.job?.kind === 'edit' && s.current?.job?.status === 'running'),
      stopping = ref(false);
    watch(running, (now) => {
      if (!now) stopping.value = false;
    });
    async function stop() {
      if (stopping.value) return;
      stopping.value = true;
      try {
        await api('run/stop', {});
        await refresh();
      } catch (e: any) {
        stopping.value = false;
        notice(e.message);
      }
    }
    async function submit() {
      if (s.uploading || s.submitting || s.current?.job?.status === 'running') return;
      const prompt = s.prompt.trim();
      if (!prompt) return;
      s.submitting = true;
      try {
        await api('run', {
          prompt,
          checks: { technical: checks.technical, verification: checks.verification },
          ...(chosenTeam.value ? { team: chosenTeam.value.id } : {}),
          ...(s.current.cmsPreviewSources?.[s.cmsPreviewMode] ? { cmsSource: s.cmsPreviewMode } : {}),
          attachments: s.attachments.map(({ id }) => ({ id, use: 'auto' })),
        });
        s.prompt = '';
        s.attachments = [];
        await refresh();
      } catch (e: any) {
        notice(e.message);
      } finally {
        s.submitting = false;
      }
    }
    return {
      t,
      s,
      APP_BASE,
      files,
      contentMenu,
      popover,
      checks,
      teamMenu,
      teams,
      chosenTeam,
      chooseTeam,
      closeTeams,
      teamName,
      sources,
      contentChoice,
      previewWarning,
      isImage,
      contentToggled,
      chooseSource,
      chosen,
      paste,
      remove,
      enter,
      submit,
      running,
      stopping,
      stop,
    };
  },
};
