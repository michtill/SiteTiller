import { ref, computed, watch, nextTick } from 'vue';
import { t } from './i18n.ts';
import { s, navigateStudio, sharedSettingsHref, openSettingsDialog, resetPreviewSelection } from './studio.ts';
import StudioSwitcher from '../../../packages/ui/studio-switcher.ts';
import StudioToggle from '../../../packages/ui/studio-toggle.ts';
import Timeline from './timeline.ts';
import PromptForm from './prompt-form.ts';
import HistoryPanel from './history-panel.ts';
import SavedDrafts from './saved-drafts.ts';
import PreviewPanel from './preview-panel.ts';
import SaveDraftDialog from './save-draft-dialog.ts';
import ShareDialog from './share-dialog.ts';
import RestoreDialog from './restore-dialog.ts';
import PublishDialog from './publish-dialog.ts';
import RealityDialog from './reality-dialog.ts';
import WebsiteNotice from './website-notice.ts';
import { dialogs } from './dialogs.ts';
// AI Studio: the conversation with its tabs on the left, the preview on the right, the width between them adjustable.
const template = `<main id="workspace" ref="workspace" :hidden="!s.session?.authenticated||undefined" :aria-busy="s.ready?undefined:'true'" :class="{resizing:dragging}" :style="{'--chat-width':width+'%'}"><aside><header class="studio-header"><StudioSwitcher menu-id="studio-switcher" active="site" :label="t('ai_studio')" :name="s.editorName" :settings-href="settingsHref" @navigate="navigate"/><StudioToggle active="site" @navigate="navigate"/><div class="workspace-tabs" role="tablist" :aria-label="t('website_workspace')"><button v-for="tab in tabs" :key="tab.name" :id="tab.id" type="button" role="tab" :aria-selected="String(s.workspaceTab===tab.name)" :aria-controls="tab.panel" :tabindex="s.workspaceTab===tab.name?0:-1" :disabled="!s.ready" @click="select(tab.name)" @keydown="tabKey($event,tab.name)"><span>{{t(tab.label)}}</span></button></div></header>
<section id="edits-panel" role="tabpanel" aria-labelledby="edits-tab" :hidden="s.workspaceTab!=='edits'||undefined"><p v-if="!s.ready&&s.loadingText" class="timeline-loading">{{s.loadingText}}</p><WebsiteNotice/><Timeline v-if="s.current" @reality="dialogs.reality()"/><div v-else id="timeline" class="timeline" aria-live="polite"></div><PromptForm/></section>
<SavedDrafts :hidden="s.workspaceTab!=='drafts'||undefined"/><HistoryPanel :hidden="s.workspaceTab!=='history'||undefined"/></aside>
<div id="splitter" role="separator" :aria-label="t('chat_width')" aria-orientation="vertical" :aria-valuenow="String(Math.round(width))" tabindex="0" @pointerdown="dragStart" @pointermove="dragMove" @pointerup="dragEnd" @lostpointercapture="dragEnd" @keydown="splitterKey"></div><PreviewPanel/></main>
<SaveDraftDialog/><ShareDialog/><RestoreDialog/><PublishDialog/><RealityDialog/>
<div id="notice" role="status" :hidden="!s.notice||undefined">{{s.notice}}</div><div id="preview-loading-status" class="preview-loading-status" role="status" aria-live="polite" aria-atomic="true">{{s.pendingSelection?t('preview_loading'):''}}</div>`;
const tabs = [
  { name: 'edits', id: 'edits-tab', panel: 'edits-panel', label: 'edit_steps', scroller: 'timeline' },
  { name: 'drafts', id: 'drafts-tab', panel: 'saved-drafts', label: 'saved_drafts', scroller: 'saved-drafts' },
  { name: 'history', id: 'history-toggle', panel: 'history', label: 'published_versions', scroller: 'history' },
] as const;
export default {
  template,
  components: {
    StudioSwitcher,
    StudioToggle,
    Timeline,
    PromptForm,
    HistoryPanel,
    SavedDrafts,
    PreviewPanel,
    SaveDraftDialog,
    ShareDialog,
    RestoreDialog,
    PublishDialog,
    RealityDialog,
    WebsiteNotice,
  },
  setup() {
    const workspace = ref<HTMLElement | null>(null);
    const settingsHref = computed(() => {
      void s.ready;
      return sharedSettingsHref();
    });
    function navigate(href: string) {
      navigateStudio(href);
    }
    function openSettings() {
      openSettingsDialog(true);
    }
    // Each tab keeps its own scroll position.
    const scroll: Record<string, number> = { edits: 0, drafts: 0, history: 0 };
    watch(
      () => s.workspaceTab,
      async (tab, previous) => {
        const before = tabs.find((x) => x.name === previous);
        if (before) scroll[previous] = document.getElementById(before.scroller)?.scrollTop || 0;
        await nextTick();
        const after = tabs.find((x) => x.name === tab)!;
        const el = document.getElementById(after.scroller);
        // The edits tab always opens on the latest edit; the other tabs keep their scroll position.
        if (tab === 'edits') {
          resetPreviewSelection();
          if (el) el.scrollTop = el.scrollHeight;
        } else if (el) el.scrollTop = scroll[tab];
      },
    );
    function select(tab: any, focus = false) {
      s.workspaceTab = tab;
      if (focus) void nextTick(() => document.getElementById(tabs.find((x) => x.name === tab)!.id)?.focus());
    }
    function tabKey(event: KeyboardEvent, tab: string) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.findIndex((x) => x.name === tab),
        next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      select(tabs[next].name, true);
    }
    // The chat width is a share of the window, remembered in this browser.
    let stored = 25;
    try {
      const value = localStorage.getItem('sitetiller-chat-width');
      if (value !== null && Number.isFinite(Number(value))) stored = Number(value);
    } catch {}
    const width = ref(Math.max(25, Math.min(65, stored)));
    const dragging = ref(false);
    function resize(value: number) {
      width.value = Math.max(25, Math.min(65, value));
      try {
        localStorage.setItem('sitetiller-chat-width', String(width.value));
      } catch {}
    }
    function dragStart(event: PointerEvent) {
      dragging.value = true;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    function dragMove(event: PointerEvent) {
      if (!dragging.value || !workspace.value) return;
      const r = workspace.value.getBoundingClientRect();
      resize(((event.clientX - r.left) / r.width) * 100);
    }
    function dragEnd() {
      dragging.value = false;
    }
    function splitterKey(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        resize(Math.round(width.value) + (event.key === 'ArrowLeft' ? -2 : 2));
      }
    }
    return {
      t,
      s,
      workspace,
      settingsHref,
      navigate,
      openSettings,
      tabs,
      select,
      tabKey,
      width,
      dragging,
      dragStart,
      dragMove,
      dragEnd,
      splitterKey,
      dialogs,
    };
  },
};
