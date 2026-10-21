import { t, localize, uiLocale } from './i18n.ts';
import StudioSwitcher from '../../../packages/ui/studio-switcher.ts';
import { confirmDialog } from '../../../packages/ui/confirm-dialog.js';
import { appBase, appPath, structurePath, commonSettingsPath } from './app-base.ts';
import { createApp, reactive, computed, onMounted, nextTick, watch, ref, defineAsyncComponent } from 'vue';
// The Formatted content editor is a separate chunk, loaded only when a form has such a field.
const MarkdownEditor = defineAsyncComponent(() => import('./markdown-editor.ts'));
import DOMPurify from 'dompurify';
import type { Schema, Row, Field } from '../server/store.ts';
import './style.css';
import '../../../packages/ui/confirm-dialog.css';
import { rowLabel, groupFields, filterRows, rowSubtitle } from './schema-view.ts';
import { reorder } from './reorder.ts';
import Architect from './architect.ts';
type Snapshot = { rows: Row[]; revision: string };
// Inside the Shell frame the studio stays alive; switching studios and leaving go through the frame.
const framed = (() => {
  try {
    return window.parent !== window && window.parent.location.origin === location.origin;
  } catch {
    return false;
  }
})();
let studioVisible = true;
function navigateStudio(href: string) {
  if (framed) window.parent.postMessage({ type: 'sitetiller-navigate', href }, location.origin);
  else location.assign(href);
}
function reportLocation() {
  if (framed)
    window.parent.postMessage(
      { type: 'sitetiller-location', href: location.pathname + location.search + location.hash },
      location.origin,
    );
}
function reportTitle() {
  if (framed && studioVisible)
    window.parent.postMessage({ type: 'sitetiller-title', title: document.title }, location.origin);
}
if (framed) {
  const push = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>) => {
    push(...args);
    reportLocation();
  };
  window.addEventListener('popstate', reportLocation);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
const template = `
<Architect :name="settings.name" v-if="architectMode&&schema" :schema="schema" :schema-revision="schemaRevision" :token="token" :readonly="viewPublished" ref="architectureEditor" @saved="structureSaved" @dirty="architectDirty=$event" @back="returnToContent"  @navigate="studioNavigate"/><div v-else class="shell">
 <aside class="sidebar" :inert="actionDialog?true:undefined"><div class="studio-brand-row"><StudioSwitcher active="content" :label="t('content_editor')" :name="settings.name" :content-href="appPath('/')" :settings-href="commonSettingsPath('','')" @navigate="studioNavigate"/></div><div class="sidebar-scroll">
 <div class="nav-label">{{t('your_collections')}}</div><nav><button v-for="(def,key) in schema?.lists" :class="{active:collection===key&&!mediaView}" @click="switchCollection(String(key))"><svg class="collection-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h13M8 12h13M8 19h13"/><path d="M3 5h1M3 12h1M3 19h1"/></svg>{{def.label}}<small>{{lists[key]?.rows.length}}</small></button></nav><div class="nav-label files-label" v-if="Object.keys(schema?.folders||{}).length">{{t('your_files')}}</div><nav v-if="Object.keys(schema?.folders||{}).length"><button v-for="(folder,key) in schema?.folders" class="media-folder" :class="{active:mediaView&&mediaFolder===key}" @click="showMedia(String(key))"><span>{{folder.type==='img'?'▧':'▤'}}</span>{{folder.label}}<small>{{folderFiles(String(key)).length}}</small></button></nav>
 <div class="cms-publication"><details class="publication-view-menu" v-if="publication.published&&(publication.unpublished||viewPublished)"><summary><span class="publication-view-label">{{viewPublished?publishedDate:t('unpublished_changes')}}<strong v-if="viewPublished" class="publication-readonly">{{t('read_only')}}</strong></span><svg class="publication-view-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><div class="publication-view-options"><button @click="chooseContentView(false,$event)" :aria-current="!viewPublished?'true':undefined">{{t('unpublished_changes')}}</button><button @click="chooseContentView(true,$event)" :aria-current="viewPublished?'true':undefined">{{publishedDate}}</button></div></details><small v-if="publication.website?.foreign||publication.website?.error" class="website-notice" role="status">{{publication.website.foreign?t('someone_else_changed_the_website_on_the_hosting'):t('hosted_website_not_updated_next_publication_retries')}}</small><template v-if="publication.unpublished&&!viewPublished"><small v-if="!publication.published" class="publication-status">{{t('unpublished_changes')}}</small><button class="publication-pending" @click="publishCms" :disabled="publishing||busy">{{t('publish_changes')}}</button><button class="discard-changes-entry" @click="discardAllChanges" :disabled="!publication.published||publishing||busy">{{t('discard_changes')}}</button></template><template v-else><small v-if="!viewPublished" class="publication-status">{{publishedDate}}</small><label v-if="!viewPublished"><input type="checkbox" :checked="liveEditing" @change="toggleLive($event)"> {{t('live_editing')}}</label></template></div><div class="sidebar-spacer" aria-hidden="true"></div><button class="structure-entry" @click="openStructure"><svg class="sidebar-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/></svg><span>{{t('structure_editor')}}</span></button></div></aside>
 <main :inert="actionDialog?true:undefined" :class="{'files-main':mediaView}"><header v-if="mediaView" class="files-header"><h1>{{schema?.folders?.[mediaFolder]?.label||t('files')}}</h1><label v-if="!viewPublished" class="primary upload">{{t('upload_file')}}<input type="file" :accept="uploadAccept" @change="upload"></label></header>
 <p v-if="externalPending">{{t('content_was_changed_elsewhere_your_unsaved_edits')}} <button @click="reload">{{t('load_current_content')}}</button></p><div role="status" aria-live="polite" class="toast" :class="noticeKind" v-if="notice"><span>{{notice}}</span><button type="button" :aria-label="t('dismiss_message')" @click="notice=''">×</button></div><div class="loading" v-if="!schema&&!notice">{{t('loading_working_content')}}</div>
 <template v-if="schema&&!mediaView&&definition">
 <div class="workspace"><section class="collection-panel" :aria-label="t('selected_collection')"><div class="collection-panel-head"><input :aria-label="t('search_records')" :placeholder="t('search_collection')" v-model="search"><select v-for="group in groups" :key="group.key" v-model="filters[group.key]" :aria-label="(t('filter')+' ')+group.field.label"><option value="">{{schema.lists[group.field.list]?.label||group.field.label}}{{t('all')}}</option><option v-for="option in groupOptions(group.key)" :value="option.value">{{option.label}}</option></select><div class="collection-panel-actions"><button v-if="!viewPublished" class="primary" @click="newRow">{{t('new_record')}}</button><button @click="reload" :disabled="busy" :aria-label="t('refresh_collection')" :title="t('refresh_collection')">↻</button><span>{{filtered.length}}</span></div></div><section class="record-list" :aria-label="t('collection_records')"><div v-for="item in filtered" :key="item.row[definition.key]" class="record" :data-row-index="item.index" :class="{selected:selected===item.index,dragging:dragFrom===item.index,'drop-before':dragTarget===item.index&&dragSide==='before','drop-after':dragTarget===item.index&&dragSide==='after'}"><button type="button" class="drag-handle" :disabled="viewPublished||busy||dirty" :aria-label="(t('reorder')+' ')+label(collection,item.row)" :title="t('drag_to_reorder_keyboard_up_down_arrow')" @pointerdown="startDrag(item.index,$event)" @pointermove="dragMove" @pointerup="dropRow" @pointercancel="endDrag" @lostpointercapture="endDrag" @keydown.up.prevent="keyboardMove(item.index,-1)" @keydown.down.prevent="keyboardMove(item.index,1)"><svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button><button class="record-select" @click="selectRow(item.index)"><div><strong>{{label(collection,item.row)}}</strong><small>{{subtitle(item.row)}}</small></div><span class="chevron">›</span></button></div><div class="empty" v-if="!filtered.length">{{t('no_records')}}<br>{{t('change_your_search_or_add_a_new')}}</div></section></section>
 <div class="form-pane"><section class="editor" v-if="draft"><div class="editor-heading"><div class="eyebrow">{{viewPublished?t('published_content_read_only'):selected===-1?t('new_record_2'):t('edit_record')}}</div><h2>{{label(collection,draft)}}</h2><span class="badge" :class="{dirty}">{{dirty?t('unsaved_changes'):t('saved')}}</span></div>
 <form @submit.prevent="save"><div class="fields"><div v-for="(field,key) in definition.columns" :key="collection+':'+key" class="field" :class="field.width||'full'"><span>{{field.label}} <b v-if="field.required">*</b></span>
 <template v-if="field.type==='generated'"><input :value="selected===-1?(draft[key]||generatedPreview[key]||''):draft[key]" @input="draft[key]=$event.target.value" :aria-label="field.label" :readonly="isReadonly(field)" :placeholder="t('assigned_on_save')"><small>{{selected===-1?t('suggested_value_assigned_only_when_saved'):t('automatically_assigned_value')}}</small></template><select v-else-if="field.type==='list'" :disabled="isReadonly(field)" v-model="draft[key]" :aria-label="field.label" :required="field.required"><option value="">{{t('select')}}</option><option v-for="row in lists[field.list]?.rows" :value="row[schema.lists[field.list].key]">{{label(field.list,row)}}</option></select>
 <MarkdownEditor v-else-if="field.type==='markdown'" v-model="draft[key]" :readonly="!!isReadonly(field)" :label="field.label" :images="imageFolders" :media-url="mediaUrl" /><template v-else-if="field.type==='html'"><div class="rich-tools" :inert="isReadonly(field)||undefined"><button type="button" :aria-label="t('bold')" @mousedown.prevent="format(String(key),'bold')"><b>B</b></button><button type="button" :aria-label="t('italic')" @mousedown.prevent="format(String(key),'italic')"><i>I</i></button><button type="button" @mousedown.prevent="format(String(key),'formatBlock','h2')">{{t('heading')}}</button><button type="button" @mousedown.prevent="format(String(key),'formatBlock','p')">{{t('paragraph')}}</button><button type="button" @mousedown.prevent="format(String(key),'insertUnorderedList')">{{t('list')}}</button><button type="button" @mousedown.prevent="openLink(String(key))">{{t('link')}}</button><button type="button" @mousedown.prevent="format(String(key),'unlink')">{{t('remove_link')}}</button><button type="button" @click="toggleSource(String(key))">{{htmlSource[key]?t('visual'):'HTML'}}</button></div><textarea v-if="htmlSource[key]" class="html-source" :readonly="isReadonly(field)" v-model="draft[key]" :maxlength="field.maxlen" :aria-label="field.label+' — HTML'" rows="16"></textarea><div v-else class="rich-content" :contenteditable="!isReadonly(field)" :aria-readonly="!!isReadonly(field)" role="textbox" :aria-label="field.label" :ref="el=>bindRich(String(key),el)" @input="richInput(String(key),$event)" @paste="pastePlain"></div></template>
 <div v-else-if="field.type==='checkbox'" class="check-option"><input type="checkbox" v-model="draft[key]" true-value="true" false-value="false" :aria-label="field.label" :disabled="isReadonly(field)"><span>{{draft[key]==='true'?t('yes'):t('no')}}</span></div><textarea :readonly="isReadonly(field)" v-else-if="['textarea','long_text'].includes(field.type)" v-model="draft[key]" :aria-label="field.label" :required="field.required" :maxlength="field.maxlen" rows="5"></textarea>
 <template v-else-if="['file','media'].includes(field.type)"><div class="media-pick"><input v-model="draft[key]" :aria-label="field.label" :required="field.required" :placeholder="t('file_path')" :readonly="isReadonly(field)"><button type="button" :disabled="isReadonly(field)||!field.folder" @click="picker=String(key)">{{t('select_2')}}</button></div><img v-if="draft[key]&&schema.folders?.[field.folder]?.type==='img'" class="field-image" :src="mediaUrl(draft[key])" :alt="t('selected_image')"><a v-else-if="draft[key]" :href="mediaUrl(draft[key])" target="_blank" rel="noopener" class="file-field-link">{{draft[key].split('/').at(-1)}}</a><small v-if="!field.folder">{{t('select_a_folder_for_this_field_in')}}</small></template>
 <div v-else-if="field.type==='color'" class="color-field"><input type="color" :disabled="isReadonly(field)" v-model="draft[key]" :aria-label="field.label+(' '+t('color_picker'))"><input :readonly="isReadonly(field)" v-model="draft[key]" :aria-label="field.label" pattern="#[a-fA-F0-9]{6}"></div>
 <input v-else-if="field.type==='number'" type="number" :value="draft[key]" @input="draft[key]=$event.target.value" :aria-label="field.label" :required="field.required" :maxlength="field.maxlen" :readonly="isReadonly(field)" step="any"><input v-else v-model="draft[key]" :aria-label="field.label" :type="['url','email','number','date','time'].includes(field.type)?field.type:'text'" :required="field.required" :maxlength="field.maxlen" :readonly="isReadonly(field)">
 <small v-if="field.hint">{{field.hint}}</small></div></div><div class="form-footer record-form-footer" v-if="!viewPublished"><button type="submit" class="primary" :disabled="busy||!dirty">{{busy?t('saving'):t('save_changes')}}</button><button type="button" class="footer-push" @click="discard" :disabled="busy||!dirty">{{t('discard_edits')}}</button><button v-if="selected>=0" type="button" class="danger" @click="remove" :disabled="busy||dirty">{{t('delete_record')}}</button></div></form>
 </section><section class="editor empty" v-else>{{t('select_a_record_to_edit')}}</section></div></div></template>
 <div class="media-grid" v-if="mediaView"><article v-for="path in visibleMedia"><img v-if="isImage(path)" :src="mediaUrl(path)" :alt="path" loading="lazy"><div class="file-icon" v-else>▤</div><strong>{{path.split('/').at(-1)}}</strong><small>{{path}}</small><a :href="mediaUrl(path)" target="_blank" rel="noopener">{{t('open_file')}}</a><button @click="copyPath(path)">{{t('copy_path')}}</button><button v-if="!viewPublished" class="danger" :disabled="busy" @click="removeMedia(path)">{{t('delete_file')}}</button></article></div><div class="empty" v-if="mediaView&&!visibleMedia.length">{{t('this_folder_is_empty_add_the_first')}}</div>
 <div class="overlay" v-if="picker" @click.self="picker=''"><section class="picker" role="dialog" aria-modal="true" :aria-label="t('select_file')"><div class="picker-head"><h2>{{pickerFolder?.label||t('select_file')}}</h2><button @click="picker=''">{{t('close')}}</button></div><div v-if="pickerFolder?.type==='img'" class="media-grid"><button v-for="path in pickerFiles" @click="pick(path)"><img :src="mediaUrl(path)" :alt="path" loading="lazy"><small>{{path.split('/').at(-1)}}</small></button></div><div v-else class="file-picker-list"><button v-for="path in pickerFiles" @click="pick(path)"><span aria-hidden="true">▤</span><strong>{{path.split('/').at(-1)}}</strong><small>{{path}}</small></button></div><p v-if="!pickerFiles.length" class="empty">{{t('there_are_no_files_in_this_folder')}}</p></section></div>
 <div class="overlay" v-if="linkDialog" @click.self="cancelLink"><section class="confirm-card" role="dialog" aria-modal="true" :aria-label="t('edit_link')" @keydown.esc.prevent="cancelLink"><h2>{{linkDialog.editing?t('edit_link'):t('insert_link')}}</h2><form @submit.prevent="saveLink"><div class="link-fields"><label for="link-url">{{t('link_url')}}</label><input id="link-url" v-model="linkDialog.url" required placeholder="https://…"><label for="link-text">{{t('link_text')}}</label><input id="link-text" v-model="linkDialog.text" required><p class="link-error" v-if="linkError" role="alert">{{linkError}}</p></div><div class="form-footer"><button type="button" @click="cancelLink">{{t('cancel')}}</button><button type="submit" class="primary">{{t('apply_link')}}</button></div></form></section></div>
 <div class="overlay" v-if="leaveOpen"><section class="confirm-card" role="dialog" aria-modal="true" :aria-label="t('unsaved_changes')"><h2>{{t('save_changes_2')}}</h2><p>{{t('this_record_has_unsaved_changes_save_them')}}</p><div class="form-footer"><button @click="chooseLeave('cancel')">{{t('cancel_2')}}</button><button @click="chooseLeave('discard')">{{t('discard_edits')}}</button><button class="primary" @click="chooseLeave('save')">{{t('save_step')}}</button></div></section></div>
 </main></div><div class="overlay" v-if="actionDialog"><section class="confirm-card" role="dialog" aria-modal="true" :aria-label="actionDialog.kind==='publish'?t('publish_changes'):t('discard_changes')"><h2>{{actionDialog.kind==='publish'?t('publish_changes'):t('discard_changes')}}</h2><p v-if="actionDialog.kind==='publish'">{{t('publish_all_saved_content_structure_and_file')}}</p><p v-else>{{t('discard_all_unpublished_changes_working_content_structure')}}</p><p v-if="actionDialog.kind==='discard'&&dirty">{{t('unsaved_edits_in_the_open_form_will')}}</p><p v-if="actionDialog.loading" role="status">{{t('loading_current_state')}}</p><p v-if="actionDialog.error" role="alert">{{actionDialog.error}}</p><p v-if="actionDialog.websiteForeign">{{t('publish_anyway_removes_their_changes_from_the_website')}}</p><div class="form-footer"><button @click="actionDialog=null" :disabled="actionDialog.working">{{t('cancel')}}</button><button v-if="actionDialog.websiteForeign" class="primary" @click="confirmPublicationAction(true)" :disabled="actionDialog.working">{{t('publish_anyway')}}</button><button v-else class="primary" @click="confirmPublicationAction()" :disabled="actionDialog.loading||actionDialog.working||!!actionDialog.error||!actionDialog.expectedRevision">{{actionDialog.working?t('working_2'):actionDialog.kind==='publish'?t('publish_changes'):t('discard_changes')}}</button></div></section></div>`;
createApp({
  template,
  setup() {
    const state = reactive({
      leaveOpen: false,
      generatedPreview: {} as Record<string, string>,
      viewPublished: false,
      contentRevision: '',
      externalPending: false,
      actionDialog: null as null | {
        kind: 'publish' | 'discard';
        loading: boolean;
        working: boolean;
        expectedRevision: string;
        error: string;
        websiteForeign?: boolean;
      },
      liveEditing: false,
      publication: { unpublished: false, published: null as any },
      publishing: false,
      schema: null as Schema | null,
      schemaRevision: '',
      architectMode: structurePath(location.pathname),
      architectDirty: false,
      settings: {
        autoPublish: false,
        theme: document.documentElement.dataset.cmsTheme || 'green',
        name: t('content_editor'),
        subtitle: 'Obsah',
      },
      lists: {} as Record<string, Snapshot>,
      collection: '',
      selected: 0,
      draft: null as Row | null,
      original: '',
      search: '',
      filters: {} as Record<string, string>,
      notice: '',
      noticeKind: 'success',
      busy: false,
      token: '',
      media: [] as string[],
      mediaView: false,
      mediaFolder: '',
      picker: '',
      htmlSource: {} as Record<string, boolean>,
      confirmation: '',
      dragFrom: -1,
      dragTarget: -1,
      dragSide: 'before',
    });
    const richElements = new Map<string, HTMLElement>();
    const linkState = reactive({
      linkDialog: null as { key: string; url: string; text: string; editing: boolean } | null,
      linkError: '',
    });
    let linkRange: Range | null = null,
      linkAnchor: HTMLAnchorElement | null = null;
    async function openLink(key: string) {
      const editor = richElements.get(key);
      if (!editor) return;
      const selection = window.getSelection();
      linkRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      if (!linkRange || !editor.contains(linkRange.commonAncestorContainer)) {
        linkRange = document.createRange();
        linkRange.selectNodeContents(editor);
        linkRange.collapse(false);
      }
      const node = linkRange.startContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const anchor = element?.closest('a');
      linkAnchor = anchor instanceof HTMLAnchorElement && editor.contains(anchor) ? anchor : null;
      linkState.linkError = '';
      linkState.linkDialog = {
        key,
        url: linkAnchor?.getAttribute('href') || '',
        text: linkAnchor?.textContent || linkRange.toString(),
        editing: !!linkAnchor,
      };
      await nextTick();
      document.getElementById('link-url')?.focus();
    }
    async function cancelLink() {
      const key = linkState.linkDialog?.key;
      linkState.linkDialog = null;
      await nextTick();
      if (key) richElements.get(key)?.focus();
      if (linkRange) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(linkRange);
      }
    }
    async function saveLink() {
      const dialog = linkState.linkDialog;
      if (!dialog) return;
      const value = dialog.url.trim();
      try {
        if (
          !value ||
          /[\u0000-\u001f]/.test(value) ||
          !['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(value, location.origin).protocol)
        )
          throw Error();
      } catch {
        linkState.linkError = t('enter_a_website_email_or_telephone_link');
        return;
      }
      const editor = richElements.get(dialog.key);
      if (!editor || !linkRange) return;
      let anchor = linkAnchor;
      if (anchor && editor.contains(anchor)) {
        anchor.setAttribute('href', value);
        if (anchor.textContent !== dialog.text) anchor.textContent = dialog.text;
      } else {
        anchor = document.createElement('a');
        anchor.setAttribute('href', value);
        anchor.textContent = dialog.text;
        linkRange.deleteContents();
        linkRange.insertNode(anchor);
      }
      state.draft![dialog.key] = editor.innerHTML;
      linkState.linkDialog = null;
      await nextTick();
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(anchor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    // The app's one confirm dialog (packages/ui); state.confirmation says a question is open.
    async function ask(message: string) {
      state.confirmation = localize(message);
      try {
        return await confirmDialog({
          title: t('confirm_action_2'),
          message: state.confirmation,
          confirm: t('confirm'),
          cancel: t('cancel'),
          label: t('confirm_action'),
        });
      } finally {
        state.confirmation = '';
      }
    }
    const architectureEditor = ref<{ save: () => Promise<boolean>; canLeave: () => Promise<boolean> } | null>(null);
    const definition = computed(() => state.schema?.lists[state.collection]);
    const dirty = computed(() =>
      state.architectMode ? state.architectDirty : !!state.draft && JSON.stringify(state.draft) !== state.original,
    );
    let leavingStudio = false;
    window.addEventListener('pageshow', () => {
      leavingStudio = false;
    });
    async function studioNavigate(target: string) {
      if (state.busy) return;
      if (target.startsWith('/settings')) target = commonSettingsPath(location.pathname, location.search);
      if (target === appPath('/structure')) {
        if (!state.architectMode) await openStructure();
        return;
      }
      if (target === appPath('/')) {
        if (state.architectMode && (await architectureEditor.value?.canLeave())) await returnToContent();
        return;
      }
      if (!['/site/', '/site/?settings=ai', '/logout'].includes(target) && !target.startsWith('/settings?returnTo='))
        return;
      // AI Studio stays alive next to this one: switching keeps unsaved forms, so no leave dialog.
      if (framed && target.startsWith('/site/')) {
        navigateStudio(target);
        return;
      }
      const allowed = state.architectMode ? await architectureEditor.value?.canLeave() : await canLeave();
      if (allowed) {
        leavingStudio = true;
        navigateStudio(target);
      }
    }
    async function openStructure(push = true) {
      if (!(await canLeave())) return;
      state.architectDirty = false;
      state.architectMode = true;
      if (push) history.pushState({}, '', appPath('/structure'));
    }
    async function returnToContent(push = true) {
      state.architectMode = false;
      state.architectDirty = false;
      if (push) history.pushState({}, '', appPath('/'));
      await load();
      await selectRow(0, true);
    }
    async function structureSaved(result: any) {
      state.schema = result.schema;
      state.schemaRevision = result.schemaRevision;
      state.lists = result.lists;
      state.architectDirty = false;
      await refreshPublication();
    }
    function isReadonly(field: { readonly?: boolean; type?: string; editableOnCreate?: boolean }) {
      return (
        state.viewPublished ||
        (field.type === 'generated' &&
          field.readonly !== false &&
          !(state.selected === -1 && field.editableOnCreate)) ||
        (state.selected !== -1 && !!field.readonly)
      );
    }
    const groups = computed(() => (state.schema ? groupFields(state.schema, state.collection) : []));
    function folderFiles(folder: string) {
      return state.media.filter((path) => path.startsWith(folder + '/'));
    }
    const visibleMedia = computed(() => (state.mediaFolder ? folderFiles(state.mediaFolder) : state.media));
    // Image folders offered by the Formatted content editor.
    const imageFolders = computed(() =>
      Object.entries(state.schema?.folders || {})
        .filter(([, folder]) => folder.type === 'img')
        .map(([folder, def]) => ({ folder, label: def.label, files: folderFiles(folder).filter(isImage) })),
    );
    const pickerFolder = computed(() => state.schema?.folders?.[definition.value?.columns[state.picker]?.folder || '']);
    const pickerFiles = computed(() => {
      const folder = definition.value?.columns[state.picker]?.folder;
      return folder ? folderFiles(folder).filter((path) => pickerFolder.value?.type !== 'img' || isImage(path)) : [];
    });
    const uploadAccept = computed(() =>
      state.schema?.folders?.[state.mediaFolder]?.type === 'img'
        ? '.png,.jpg,.jpeg,.webp,.gif,.avif'
        : state.schema?.folders?.[state.mediaFolder]?.type === 'other'
          ? '.pdf,.txt,.doc,.docx,.xls,.xlsx,.odt,.ods,.ppt,.pptx'
          : '.png,.jpg,.jpeg,.webp,.gif,.avif,.pdf,.txt,.doc,.docx,.xls,.xlsx,.odt,.ods,.ppt,.pptx',
    );
    const filtered = computed(() =>
      state.schema && definition.value
        ? filterRows(
            state.schema,
            state.collection,
            state.lists[state.collection]?.rows || [],
            state.filters,
            state.search,
          )
        : [],
    );
    function label(name: string, row: Row) {
      return state.schema ? rowLabel(state.schema, name, row) : '';
    }
    function groupOptions(key: string) {
      const field = definition.value!.columns[key],
        target = field.list;
      if (target && state.schema!.lists[target])
        return (state.lists[target]?.rows || []).map((row) => ({
          value: row[state.schema!.lists[target].key],
          label: label(target, row),
        }));
      return [...new Set((state.lists[state.collection]?.rows || []).map((row) => row[key]).filter(Boolean))].map(
        (value) => ({ value, label: value }),
      );
    }
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    function notice(message: string, kind = 'success') {
      clearTimeout(noticeTimer);
      state.notice = localize(message);
      state.noticeKind = kind;
      noticeTimer = setTimeout(
        () => {
          state.notice = '';
        },
        kind === 'error' ? 6500 : 3500,
      );
    }
    async function api(path: string, options: RequestInit = {}) {
      const res = await fetch(appPath(path), {
        ...options,
        headers: { 'Content-Type': 'application/json', 'X-CMS-Token': state.token, ...options.headers },
      });
      const result = await res.json();
      if (!res.ok)
        throw Object.assign(Error(localize(result.error || t('the_operation_failed'))), {
          websiteForeign: result.websiteForeign === true,
        });
      return result;
    }
    watch(
      () => state.settings.theme,
      (theme) => (document.documentElement.dataset.cmsTheme = theme || 'green'),
      { immediate: true },
    );
    const publishedDate = computed(() => {
      const value = state.publication.published?.publishedAt;
      if (!value) return t('not_published_yet_2');
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? t('not_published_yet_2')
        : t('published') +
            ' ' +
            new Intl.DateTimeFormat(uiLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
    });
    async function refreshPublication() {
      const [publication, mode] = await Promise.all([api('/api/publication'), api('/api/edit-mode')]);
      state.publication = publication;
      state.liveEditing = mode.autoPublish;
    }
    let publicationRefresh = false;
    async function refreshExternalPublication() {
      if (
        !state.schema ||
        state.busy ||
        state.publishing ||
        state.actionDialog ||
        state.confirmation ||
        state.leaveOpen ||
        publicationRefresh ||
        document.hidden ||
        !studioVisible
      )
        return;
      publicationRefresh = true;
      try {
        const revision = await api('/api/revision');
        state.publication = revision.publication;
        state.liveEditing = revision.autoPublish;
        if (
          (state.viewPublished ? revision.publication.published?.revision : revision.contentRevision) ===
          state.contentRevision
        )
          return;
        const result = await api(state.viewPublished ? '/api/published-bootstrap' : '/api/bootstrap');
        if (result.contentRevision === state.contentRevision) return;
        if (dirty.value || state.busy || state.confirmation || state.actionDialog) {
          state.token = result.token;
          state.externalPending = true;
          return;
        }
        const selectedKey = state.draft && definition.value ? state.draft[definition.value.key] : null;
        applyContent(result);
        if (!state.mediaView)
          await selectRow(
            selectedKey
              ? Math.max(
                  0,
                  state.lists[state.collection]?.rows.findIndex((row) => row[definition.value!.key] === selectedKey) ??
                    0,
                )
              : 0,
            true,
          );
        notice(t('content_was_updated'));
      } catch {
      } finally {
        publicationRefresh = false;
      }
    }
    window.addEventListener('focus', () => {
      void refreshExternalPublication();
    });
    window.addEventListener('message', (event) => {
      if (!framed || event.source !== window.parent || event.origin !== location.origin) return;
      const data = event.data || {};
      if (data.type === 'sitetiller-visibility') {
        studioVisible = !!data.visible;
        if (studioVisible) {
          reportLocation();
          reportTitle();
          void refreshExternalPublication();
        }
      } else if (
        data.type === 'sitetiller-open' &&
        typeof data.href === 'string' &&
        new URL(data.href, location.href).pathname === appPath('/structure') &&
        !state.architectMode
      )
        void openStructure();
    });
    reportLocation();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refreshExternalPublication();
    });
    setInterval(() => {
      void refreshExternalPublication();
    }, 15000);
    async function openPublicationAction(kind: 'publish' | 'discard') {
      if (!state.publication.unpublished || state.publishing || state.busy || state.actionDialog) return;
      if (dirty.value) {
        if (!(await canLeave())) return;
        await selectRow(state.selected === -1 ? 0 : state.selected, true);
      }
      state.actionDialog = { kind, loading: true, working: false, expectedRevision: '', error: '' };
      const dialog = state.actionDialog;
      try {
        const result = await api('/api/design-restore-state');
        if (state.actionDialog === dialog) dialog.expectedRevision = result.revision;
      } catch (e: any) {
        if (state.actionDialog === dialog) dialog.error = e.message;
      } finally {
        if (state.actionDialog === dialog) dialog.loading = false;
      }
    }
    function publishCms() {
      return openPublicationAction('publish');
    }
    function discardAllChanges() {
      return openPublicationAction('discard');
    }
    // overrideWebsite: "Publish anyway" over someone else's change in the website Git (documentation 7.7).
    async function confirmPublicationAction(overrideWebsite = false) {
      const dialog = state.actionDialog;
      if (
        !dialog ||
        dialog.loading ||
        dialog.working ||
        (dialog.error && !(overrideWebsite && dialog.websiteForeign)) ||
        !dialog.expectedRevision ||
        (dialog.kind === 'publish' && dirty.value)
      )
        return;
      dialog.working = true;
      state.publishing = true;
      try {
        const result = await api(dialog.kind === 'publish' ? '/api/publication' : '/api/discard-changes', {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            expectedRevision: dialog.expectedRevision,
            ...(overrideWebsite ? { overrideWebsite: true } : {}),
          }),
        });
        if (dialog.kind === 'discard') {
          await load();
          state.mediaView = false;
          state.search = '';
          await selectRow(0, true);
        } else state.publication = result;
        state.actionDialog = null;
        if (dialog.kind === 'publish' && result.warning) notice(result.warning, 'error');
        else
          notice(
            dialog.kind === 'publish'
              ? t('content_changes_have_been_published')
              : t('unpublished_changes_were_discarded_the_published_version'),
          );
      } catch (e: any) {
        dialog.error = e.message;
        dialog.websiteForeign = e.websiteForeign === true;
      } finally {
        dialog.working = false;
        state.publishing = false;
      }
    }
    async function toggleLive(event: Event) {
      const checked = (event.target as HTMLInputElement).checked;
      try {
        const result = await api('/api/edit-mode', { method: 'POST', body: JSON.stringify({ autoPublish: checked }) });
        state.liveEditing = result.autoPublish;
        notice(checked ? t('live_editing_is_on_every_save_publishes') : t('live_editing_is_off'));
      } catch (e: any) {
        (event.target as HTMLInputElement).checked = state.liveEditing;
        notice(e.message, 'error');
      }
    }
    function applyContent(result: any) {
      state.schema = result.schema;
      state.schemaRevision = result.schemaRevision;
      state.contentRevision = result.contentRevision || '';
      if (state.viewPublished)
        for (const def of Object.values(state.schema!.lists))
          for (const field of Object.values(def.columns)) field.readonly = true;
      state.settings = { ...state.settings, ...result.settings };
      state.liveEditing = result.autoPublish;
      document.title = state.settings.name + (' ' + t('content_editor_3'));
      reportTitle();
      state.lists = result.lists;
      state.token = result.token;
      if (!Object.hasOwn(state.schema!.lists, state.collection))
        state.collection = Object.keys(state.schema!.lists)[0] || '';
      state.filters = Object.fromEntries(groupFields(state.schema!, state.collection).map(({ key }) => [key, '']));
      state.media = result.media || [];
      if (state.mediaView && !Object.hasOwn(state.schema!.folders || {}, state.mediaFolder)) state.mediaView = false;
      state.externalPending = false;
    }
    async function load() {
      const [result] = await Promise.all([
        api(state.viewPublished ? '/api/published-bootstrap' : '/api/bootstrap'),
        refreshPublication(),
      ]);
      applyContent(result);
    }
    function chooseContentView(published: boolean, event: Event) {
      (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
      return switchContentView({ target: { value: published ? 'published' : 'working' } } as unknown as Event);
    }
    async function switchContentView(event: Event) {
      const element = event.target as HTMLSelectElement,
        next = element.value === 'published';
      if (!(await canLeave())) {
        element.value = state.viewPublished ? 'published' : 'working';
        return;
      }
      state.busy = true;
      try {
        const result = await api(next ? '/api/published-bootstrap' : '/api/bootstrap');
        state.viewPublished = next;
        applyContent(result);
        state.mediaView = false;
        state.search = '';
        await selectRow(0, true);
      } catch (e: any) {
        element.value = state.viewPublished ? 'published' : 'working';
        notice(e.message, 'error');
      } finally {
        state.busy = false;
      }
    }
    function bindRich(key: string, element: unknown) {
      if (element instanceof HTMLElement) richElements.set(key, element);
      else richElements.delete(key);
    }
    async function fill() {
      state.htmlSource = {};
      await nextTick();
      for (const [key, element] of richElements)
        if (state.draft) element.innerHTML = DOMPurify.sanitize(state.draft[key] || '');
    }
    async function toggleSource(key: string) {
      state.htmlSource[key] = !state.htmlSource[key];
      await nextTick();
      if (!state.htmlSource[key] && state.draft) {
        const element = richElements.get(key);
        if (element) element.innerHTML = DOMPurify.sanitize(state.draft[key] || '');
      }
    }
    let leaveResolve: ((value: boolean) => void) | null = null;
    async function chooseLeave(choice: 'save' | 'discard' | 'cancel') {
      state.leaveOpen = false;
      const resolve = leaveResolve;
      leaveResolve = null;
      resolve?.(choice === 'save' ? await save() : choice === 'discard');
    }
    async function canLeave() {
      if (state.busy || state.leaveOpen) return false;
      if (!dirty.value) return true;
      state.leaveOpen = true;
      return new Promise<boolean>((resolve) => {
        leaveResolve = resolve;
      });
    }
    async function selectRow(index: number, force = false) {
      if (!force && !(await canLeave())) return;
      state.selected = index;
      const row = state.lists[state.collection]?.rows[index];
      state.draft = row ? clone(row) : null;
      state.original = JSON.stringify(state.draft);
      await fill();
    }
    async function switchCollection(name: string) {
      if (!(await canLeave())) return;
      state.collection = name;
      state.mediaView = false;
      state.search = '';
      state.filters = Object.fromEntries(groupFields(state.schema!, name).map(({ key }) => [key, '']));
      state.notice = '';
      await selectRow(0, true);
    }
    async function newRow() {
      if (!(await canLeave())) return;
      state.generatedPreview = {};
      state.selected = -1;
      state.draft = Object.fromEntries(
        Object.keys(definition.value!.columns).map((k) => [
          k,
          definition.value!.columns[k].default ?? (definition.value!.columns[k].type === 'checkbox' ? 'false' : ''),
        ]),
      );
      state.original = '';
      await fill();
      if (Object.values(definition.value!.columns).some((f) => f.type === 'generated')) {
        const draft = state.draft,
          collection = state.collection;
        try {
          const result = await api('/api/generated-values?collection=' + encodeURIComponent(collection));
          if (state.selected === -1 && state.draft === draft && state.collection === collection)
            state.generatedPreview = result.values;
        } catch (e: any) {
          notice(e.message, 'error');
        }
      }
    }
    async function persist(rows: Row[], message = t('changes_were_saved')) {
      if (state.viewPublished) return false;
      state.busy = true;
      try {
        state.lists[state.collection] = await api('/api/lists/' + state.collection, {
          method: 'PUT',
          body: JSON.stringify({
            rows,
            revision: state.lists[state.collection].revision,
            schemaRevision: state.schemaRevision,
          }),
        });
        await refreshPublication();
        notice(
          (state.lists[state.collection] as any).publicationWarning || message,
          (state.lists[state.collection] as any).publicationWarning ? 'error' : 'success',
        );
        return true;
      } catch (e: any) {
        notice(e.message, 'error');
        return false;
      } finally {
        state.busy = false;
      }
    }
    async function save() {
      if (state.busy || state.viewPublished || !state.draft) return false;
      const form = document.querySelector<HTMLFormElement>('.editor form');
      if (form && !form.reportValidity()) return false;
      for (const [k, f] of Object.entries(definition.value!.columns))
        if (f.type === 'html') state.draft[k] = DOMPurify.sanitize(state.draft[k]);
      const rows = clone(state.lists[state.collection].rows);
      let index = state.selected;
      if (index === -1) {
        rows.push(clone(state.draft));
        index = rows.length - 1;
      } else rows[index] = clone(state.draft);
      if (await persist(rows)) {
        await selectRow(index, true);
        return true;
      }
      return false;
    }
    async function discard() {
      if (!dirty.value || !(await ask(t('discard_unsaved_changes')))) return;
      if (state.selected === -1) await selectRow(0, true);
      else await selectRow(state.selected, true);
    }
    let pointerStart: { index: number; x: number; y: number; id: number } | null = null;
    function endDrag() {
      pointerStart = null;
      state.dragFrom = -1;
      state.dragTarget = -1;
    }
    function startDrag(index: number, event: PointerEvent) {
      if (state.busy || dirty.value || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.focus();
      pointerStart = { index, x: event.clientX, y: event.clientY, id: event.pointerId };
      handle.setPointerCapture(event.pointerId);
    }
    function dragMove(event: PointerEvent) {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5 && state.dragFrom < 0) return;
      state.dragFrom = pointerStart.index;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.record');
      if (!row) {
        state.dragTarget = -1;
        return;
      }
      state.dragTarget = Number(row.dataset.rowIndex);
      const box = row.getBoundingClientRect();
      state.dragSide = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    }
    async function reorderTo(from: number, insertion: number) {
      if (state.busy || dirty.value) return;
      const current = state.lists[state.collection].rows,
        rows = reorder(current, from, insertion);
      if (rows === current) return;
      const selectedKey = state.selected >= 0 ? current[state.selected]?.[definition.value!.key] : null;
      if (await persist(rows, t('record_order_was_saved')))
        await selectRow(selectedKey ? rows.findIndex((row) => row[definition.value!.key] === selectedKey) : 0, true);
    }
    async function dropRow(event: PointerEvent) {
      const from = state.dragFrom,
        insertion = state.dragTarget + (state.dragSide === 'after' ? 1 : 0),
        valid = from >= 0 && state.dragTarget >= 0;
      endDrag();
      const handle = event.currentTarget as HTMLElement;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (valid) await reorderTo(from, insertion);
    }
    async function keyboardMove(index: number, delta: number) {
      if (index + delta < 0 || index + delta >= state.lists[state.collection].rows.length) return;
      await reorderTo(index, index + (delta > 0 ? 2 : -1));
    }
    async function remove() {
      if (!(await ask(t('delete_this_record')))) return;
      const rows = clone(state.lists[state.collection].rows);
      rows.splice(state.selected, 1);
      if (await persist(rows)) await selectRow(Math.max(0, Math.min(state.selected, rows.length - 1)), true);
    }
    async function reload() {
      if (!(await canLeave())) return;
      try {
        await load();
        await selectRow(0, true);
        notice(t('content_was_reloaded'));
      } catch (e: any) {
        notice(e.message, 'error');
      }
    }
    async function removeMedia(path: string) {
      if (state.busy) return;
      try {
        const check = await api('/api/media-usage?path=' + encodeURIComponent(path));
        if (check.usage.length) {
          notice(
            t('cannot_delete_the_file_it_is_used') +
              ' ' +
              check.usage.map((u: any) => u.collection + ' / ' + u.record + ' / ' + u.field).join('; '),
            'error',
          );
          return;
        }
        if (!(await ask('Opravdu odstranit soubor „' + path.split('/').at(-1) + '“?'))) return;
        state.busy = true;
        const result = await api('/api/media?path=' + encodeURIComponent(path), { method: 'DELETE' });
        state.media = await api('/api/media');
        await refreshPublication();
        notice(result.publicationWarning || t('file_was_deleted'), result.publicationWarning ? 'error' : 'success');
      } catch (e: any) {
        notice(e.message, 'error');
      } finally {
        state.busy = false;
      }
    }
    function mediaUrl(path: string) {
      return appPath(
        (state.viewPublished ? '/published/media/' : '/media/') + path.split('/').map(encodeURIComponent).join('/'),
      );
    }
    function isImage(path: string) {
      return /\.(png|jpe?g|webp|gif|avif)$/i.test(path);
    }
    function pick(path: string) {
      state.draft![state.picker] = path;
      state.picker = '';
    }
    async function showMedia(folder: string) {
      if (!(await canLeave())) return;
      state.draft = null;
      state.mediaView = true;
      state.mediaFolder = folder;
      state.notice = '';
      state.media = state.viewPublished ? (await api('/api/published-bootstrap')).media : await api('/api/media');
    }
    async function upload(event: Event) {
      const input = event.target as HTMLInputElement,
        file = input.files?.[0];
      if (!file) return;
      try {
        state.busy = true;
        const result = await api(
          '/api/media?name=' + encodeURIComponent(file.name) + '&folder=' + encodeURIComponent(state.mediaFolder),
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
        );
        state.media = await api('/api/media');
        await refreshPublication();
        notice(result.publicationWarning || t('file_was_uploaded'), result.publicationWarning ? 'error' : 'success');
      } catch (e: any) {
        notice(e.message, 'error');
      } finally {
        state.busy = false;
        input.value = '';
      }
    }
    function richInput(key: string, event: Event) {
      state.draft![key] = (event.target as HTMLElement).innerHTML;
    }

    function pastePlain(event: ClipboardEvent) {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || '');
    }
    function format(key: string, command: string, value?: string) {
      const element = richElements.get(key);
      element?.focus();
      document.execCommand(command, false, value);
      if (element) state.draft![key] = element.innerHTML;
    }
    async function copyPath(path: string) {
      const value = path;
      try {
        await navigator.clipboard.writeText(value);
        notice(t('path_was_copied'));
      } catch {
        notice(t('path') + ' ' + value);
      }
    }
    function subtitle(row: Row) {
      return state.schema ? rowSubtitle(state.schema, state.collection, row, state.lists) : '';
    }
    onMounted(async () => {
      try {
        await load();
        await selectRow(0, true);
      } catch (e: any) {
        notice(e.message, 'error');
      }
    });
    window.addEventListener('beforeunload', (event) => {
      if (!leavingStudio && (dirty.value || state.architectDirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's')
        return;
      event.preventDefault();
      if (state.actionDialog) return;
      if (state.architectMode) {
        void architectureEditor.value?.save();
        return;
      }
      if (state.busy || !dirty.value || state.confirmation || state.leaveOpen || linkState.linkDialog || !state.draft)
        return;
      const form = document.querySelector<HTMLFormElement>('.editor form');
      if (form?.reportValidity()) void save();
    });
    window.addEventListener('popstate', async () => {
      const target = structurePath(location.pathname);
      if (target === state.architectMode) return;
      if (state.architectMode) {
        if (await architectureEditor.value?.canLeave()) await returnToContent(false);
        else history.pushState({}, '', appPath('/structure'));
      } else {
        if (await canLeave()) {
          state.architectMode = true;
          state.architectDirty = false;
        } else history.pushState({}, '', appPath('/'));
      }
    });
    return {
      t,
      commonSettingsPath,
      chooseLeave,
      isReadonly,
      chooseContentView,
      switchContentView,
      publishedDate,
      discardAllChanges,
      confirmPublicationAction,
      publishCms,
      toggleLive,
      appBase,
      appPath,
      studioNavigate,
      architectureEditor,
      openStructure,
      returnToContent,
      structureSaved,
      ...Object.fromEntries(
        Object.keys(linkState).map((k) => [
          k,
          computed({
            get: () => linkState[k as keyof typeof linkState],
            set: (v) => {
              (linkState as any)[k] = v;
            },
          }),
        ]),
      ),
      ...Object.fromEntries(
        Object.keys(state).map((k) => [
          k,
          computed({
            get: () => state[k as keyof typeof state],
            set: (v) => {
              (state as any)[k] = v;
            },
          }),
        ]),
      ),
      definition,
      dirty,
      filtered,
      groups,
      label,
      groupOptions,
      bindRich,
      toggleSource,
      switchCollection,
      selectRow,
      newRow,
      save,
      discard,
      startDrag,
      endDrag,
      dragMove,
      dropRow,
      keyboardMove,
      remove,
      reload,
      showMedia,
      upload,
      removeMedia,
      mediaUrl,
      isImage,
      pick,
      copyPath,
      subtitle,
      richInput,
      pastePlain,
      format,
      folderFiles,
      visibleMedia,
      uploadAccept,
      pickerFolder,
      imageFolders,
      pickerFiles,
      openLink,
      cancelLink,
      saveLink,
    };
  },
})
  .provide('translate', t)
  .component('StudioSwitcher', StudioSwitcher)
  .component('Architect', Architect)
  .component('MarkdownEditor', MarkdownEditor)
  .mount('#app');
