import { t, localize, uiLocale } from './i18n.ts';
import { confirmDialog } from '../../../packages/ui/confirm-dialog.js';
// Field types with a default value (as the server keeps them).
const defaultValueTypes = [
  'checkbox',
  'text',
  'short_text',
  'textarea',
  'long_text',
  'markdown',
  'number',
  'color',
  'url',
  'email',
];
import { fieldTypeLabels } from '../field-catalog.ts';
import { appBase, appPath } from './app-base.ts';
import { reactive, computed, watch, nextTick } from 'vue';
import { reorder } from './reorder.ts';
import type { Schema, Field } from '../server/store.ts';
const types = Object.fromEntries(Object.entries(fieldTypeLabels).map(([id, label]) => [id, localize(label)]));
const template = `
<div class="architect-screen"><aside class="settings-band structure-band"><div class="shell-brand"><div class="studio-switcher-summary"><span class="studio-menu-toggle studio-menu-active" :title="t('structure')" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/></svg></span><span class="studio-logo"><span class="studio-switcher-name">{{name}}</span><small>{{t('structure')}}</small></span></div><StudioToggle :content-href="contentHref" @navigate="$emit('navigate',$event)"/></div><button type="button" class="shell-back architect-back" @click="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>{{t('back')}}</button><nav class="settings-nav architect-tabs" :aria-label="t('structure_editor')"><button type="button" :aria-current="tab==='collections'?'page':undefined" @click="tab='collections'">{{t('collections')}} <small>{{Object.keys(draft.lists).length}}</small></button><button type="button" :aria-current="tab==='folders'?'page':undefined" @click="tab='folders'">{{t('file_folders')}} <small>{{Object.keys(draft.folders||{}).length}}</small></button></nav></aside>
<main class="architect-main"><header class="architect-toolbar"><p class="architect-intro">{{t('define_collections_fields_relations_and_file_folders')}}</p><strong v-if="readonly" class="publication-readonly">{{t('read_only')}}</strong><span class="badge" :class="{dirty}">{{dirty?t('unsaved_changes'):t('saved')}} {{t('version_2')}} {{draft.version}}</span><div class="architect-controls" v-if="!readonly"><button @click="reset" :disabled="busy||!dirty">{{t('discard_edits')}}</button><button class="primary" @click="save" :disabled="busy||!dirty">{{busy?t('saving'):t('save_structure')}}</button></div></header>
 <div class="toast" :class="noticeKind" v-if="notice" role="status">{{notice}}<button @click="notice=''" :aria-label="t('dismiss_message')">×</button></div>
 <div class="structure-layout" v-if="tab==='collections'"><aside class="structure-list"><button class="primary" :disabled="readonly" @click="openAdd('collection')">{{t('add_collection')}}</button><button type="button" class="from-template" :disabled="readonly||busy||dirty" :title="dirty?t('save_or_discard_changes_first'):undefined" @click="templatesOpen=true">{{t('tpl_from_template')}}</button><div v-for="(def,id) in draft.lists" class="collection-order-row" data-order-kind="collections" :data-order-key="id" :class="orderClasses('collections',String(id))"><button type="button" class="drag-handle structure-grip" :aria-label="(t('reorder')+' ')+def.label" :title="t('drag_to_reorder')" :disabled="busy||readonly" @pointerdown="startOrderDrag('collections',String(id),$event)" @pointermove="moveOrderDrag" @pointerup="dropOrderDrag" @pointercancel="endOrderDrag" @lostpointercapture="endOrderDrag" @keydown.up.prevent="keyboardOrder('collections',String(id),-1)" @keydown.down.prevent="keyboardOrder('collections',String(id),1)"><svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button><button class="structure-item" :class="{active:selected===id}" @click="selected=String(id)"><strong>{{def.label}}</strong><small>{{id}} · {{Object.keys(def.columns).length}} {{t('fields')}}</small></button></div><p v-if="!Object.keys(draft.lists).length">{{t('no_collections_yet_add_the_first_one')}}</p></aside>
 <section class="structure-editor" v-if="definition"><div class="structure-scroll"><div class="structure-title"><h2>{{definition.label}}</h2></div>
 <fieldset class="readonly-group" :disabled="readonly"><div class="fields"><label class="field half"><span>{{t('collection_name')}}</span><input v-model="definition.label"></label><label class="field half"><span>{{t('collection_code')}}</span><input :value="selected" readonly><small>{{t('stable_identifier_for_data_and_relations')}}</small></label></div></fieldset>

 <div class="fields-overview"><div class="fields-overview-inner"><div class="field-table-head"><span aria-hidden="true"></span><h3>{{t('collection_fields')}}</h3><span>{{t('unique_key')}}</span><span>{{t('form_width')}}</span><span aria-hidden="true"></span></div><article class="field-definition" v-for="(field,id) in definition.columns" :key="selected+':'+id" :class="[{expanded:expandedField===id},orderClasses('fields',String(id))]" data-order-kind="fields" :data-order-key="id"><div class="field-heading"><button type="button" class="drag-handle structure-grip" :aria-label="(t('reorder')+' ')+field.label" :title="t('drag_to_reorder')" :disabled="busy||readonly" @pointerdown="startOrderDrag('fields',String(id),$event)" @pointermove="moveOrderDrag" @pointerup="dropOrderDrag" @pointercancel="endOrderDrag" @lostpointercapture="endOrderDrag" @keydown.up.prevent="keyboardOrder('fields',String(id),-1)" @keydown.down.prevent="keyboardOrder('fields',String(id),1)"><svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button><button type="button" class="field-toggle" :aria-expanded="expandedField===id" :aria-controls="'definition-'+selected+'-'+id" @click="expandedField=expandedField===id?'':String(id)"><span class="field-caret" aria-hidden="true">{{expandedField===id?'▾':'▸'}}</span><strong>{{field.label}}</strong><code>{{id}}</code><span class="field-type">{{types[field.type]||field.type}}</span></button><div class="field-choice"><input type="checkbox" :disabled="readonly" :aria-label="t('unique_key')+' '+field.label+' ('+id+')'" :checked="definition.key===id" @change="$event.target.checked?definition.key=String(id):$event.target.checked=true"></div><div class="field-choice field-width"><select :disabled="readonly" :aria-label="t('form_width')+' '+field.label+' ('+id+')'" :value="field.width||'full'" @change="field.width=$event.target.value"><option value="full">{{t('full_row')}}</option><option value="half">{{t('half')}}</option><option value="third">{{t('third')}}</option></select></div><fieldset class="field-controls readonly-group" :disabled="readonly"><button class="danger" @click="removeField(String(id))">{{t('remove')}}</button></fieldset></div><fieldset v-if="expandedField===id" :id="'definition-'+selected+'-'+id" class="field-details readonly-group" :disabled="readonly"><div class="fields"><label class="field half"><span>{{t('label')}}</span><input v-model="field.label"></label><label class="field half"><span>{{t('help_text')}}</span><input v-model="field.hint"></label><label class="field half"><span>{{t('field_type')}}</span><select v-model="field.type" @change="fieldTypeChanged(field)"><option v-for="(title,type) in offeredTypes(field.type)" :value="type">{{title}}</option></select></label><label class="field half" v-if="field.type==='generated'"><span>{{t('value_formula')}}</span><input v-model="field.valuePattern" required pattern=".*#.*" maxlength="500"><small>abc-### -> abc-001, abc-002, abc-003...</small></label><label class="field half" v-if="field.type==='list'"><span>{{t('target_collection')}}</span><select v-model="field.list"><option value="">{{t('select')}}</option><option v-for="(def,name) in draft.lists" :value="name">{{def.label}}</option></select></label><label class="field half" v-if="['file','media'].includes(field.type)"><span>{{t('file_folder')}}</span><select v-model="field.folder"><option value="">{{t('select_folder')}}</option><option v-for="(folder,name) in draft.folders" :value="name">{{folder.label}}</option></select></label><label class="field half" v-if="['text','short_text','textarea','long_text'].includes(field.type)"><span>{{t('pattern_regular_expression')}}</span><input :value="field.pattern" @input="setPattern(field,$event.target.value)" placeholder="[A-Za-z0-9_-]+"><small>{{t('without_delimiters_matches_the_entire_value_leave')}}</small></label><div class="field half" v-if="!['generated','text','short_text','textarea','long_text','list'].includes(field.type)&&!['file','media'].includes(field.type)" aria-hidden="true"></div><label class="field half" v-if="defaultValueTypes.includes(field.type)"><span>{{t('default_value')}}</span><select v-if="field.type==='checkbox'" v-model="field.default"><option value="false">{{t('no')}}</option><option value="true">{{t('yes')}}</option></select><MarkdownEditor v-else-if="field.type==='markdown'" :model-value="field.default||''" @update:model-value="setDefault(field,$event)" :label="t('default_value')" /><textarea v-else-if="['textarea','long_text'].includes(field.type)" rows="3" :value="field.default||''" @input="setDefault(field,$event.target.value)"></textarea><div v-else-if="field.type==='color'" class="color-field"><input type="color" :value="field.default||'#000000'" @input="setDefault(field,$event.target.value)" :aria-label="t('default_value')+' '+t('color_picker')"><input :value="field.default||''" pattern="#[a-fA-F0-9]{6}" placeholder="#RRGGBB" @input="setDefault(field,$event.target.value)"></div><input v-else :type="['number','url','email'].includes(field.type)?field.type:'text'" :step="field.type==='number'?'any':undefined" :value="field.default||''" @input="setDefault(field,$event.target.value)"><small>{{t('prefills_new_records_a_new_field_also')}}</small></label></div><div class="field-flags"><label class="check-option"><input type="checkbox" v-model="field.required">{{t('required_field')}}</label><label class="check-option"><input type="checkbox" v-model="field.readonly" @change="readonlyChanged(field)">{{t('read_only_in_the_content_editor')}}</label><label v-if="field.readonly" class="check-option"><input type="checkbox" :checked="field.type!=='generated'||!!field.editableOnCreate" :disabled="field.type!=='generated'" @change="setEditableOnCreate(field,$event.target.checked)">{{t('editable_for_a_new_item')}}</label><label class="check-option"><input type="checkbox" :checked="displayFields.includes(String(id))" @change="toggleDisplay(String(id),$event.target.checked)">{{t('record_display_fields')}}</label><label class="check-option"><input type="checkbox" v-model="definition.group" :value="id">{{t('filters_and_grouping')}}</label><span v-if="definition.key===id">{{t('collection_unique_key')}}</span></div></fieldset></article></div></div><div class="fields-add"><button :disabled="readonly" @click="openAdd('field')">{{t('add_field')}}</button></div>

 <div class="structure-footer"><button class="danger" :disabled="readonly" @click="removeCollection">{{t('delete_collection')}}</button></div>
 </div></section><section class="structure-editor empty" v-else>{{t('select_or_create_a_collection')}}</section></div>
 <div class="structure-layout folders-layout" v-else-if="tab==='folders'"><aside class="structure-list"><button class="primary" :disabled="readonly" @click="openAdd('folder')">{{t('add_folder')}}</button><div v-for="(folder,id) in draft.folders" class="collection-order-row" data-order-kind="folders" :data-order-key="id" :class="orderClasses('folders',String(id))"><button type="button" class="drag-handle structure-grip" :aria-label="(t('reorder')+' ')+folder.label" :title="t('drag_to_reorder')" :disabled="busy||readonly" @pointerdown="startOrderDrag('folders',String(id),$event)" @pointermove="moveOrderDrag" @pointerup="dropOrderDrag" @pointercancel="endOrderDrag" @lostpointercapture="endOrderDrag" @keydown.up.prevent="keyboardOrder('folders',String(id),-1)" @keydown.down.prevent="keyboardOrder('folders',String(id),1)"><svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button><button class="structure-item" :class="{active:selectedFolder===id}" @click="selectedFolder=String(id)"><strong>{{folder.label}}</strong><small>{{id}} · {{folder.type==='img'?t('images'):t('documents_and_other_files')}}</small></button></div><p v-if="!Object.keys(draft.folders||{}).length">{{t('add_the_first_folder')}}</p></aside>
 <section class="structure-editor" v-if="folderDefinition"><div class="structure-scroll"><div class="structure-title"><h2>{{folderDefinition.label}}</h2></div><p class="structure-description">{{t('every_folder_appears_under_your_files_manage')}}</p><fieldset class="readonly-group" :disabled="readonly"><div class="fields"><label class="field half"><span>{{t('name')}}</span><input v-model="folderDefinition.label"></label><label class="field half"><span>{{t('folder_code')}}</span><input :value="selectedFolder" readonly></label><label class="field half"><span>{{t('file_type')}}</span><select v-model="folderDefinition.type"><option value="img">{{t('images')}}</option><option value="other">{{t('documents_and_other_files')}}</option></select></label><label class="field half"><span>{{t('max_file_size_mb')}}</span><input type="number" min="1" max="100" step="1" inputmode="numeric" :value="folderDefinition.maxSizeMb??''" placeholder="20" @input="setFolderLimit(folderDefinition,$event.target.value)"><small>{{t('max_file_size_help')}}</small></label></div></fieldset>
 <div class="structure-footer"><button class="danger" :disabled="readonly" @click="removeFolder(selectedFolder)">{{t('delete_folder')}}</button></div></div></section><section class="structure-editor empty" v-else>{{t('add_the_first_folder')}}</section></div></main>
 <div class="overlay" v-if="addKind" @click.self="addKind=''"><section class="confirm-card" role="dialog" aria-modal="true" :aria-label="t('add_to_structure')"><h2>{{addKind==='collection'?t('new_collection'):addKind==='field'?t('new_field'):t('new_folder')}}</h2><form @submit.prevent="add"><div class="link-fields"><label for="structure-name">{{t('name')}}</label><input id="structure-name" v-model="newName" required><label for="structure-code">{{t('code')}}</label><input id="structure-code" v-model="newCode" pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" required><small>{{t('without_spaces_or_accented_characters_for_example')}}</small><template v-if="addKind==='field'"><label for="structure-type">{{t('field_type')}}</label><select id="structure-type" v-model="newType"><option v-for="(title,type) in offeredTypes('')" :value="type">{{title}}</option></select></template><template v-if="addKind==='folder'"><label for="folder-type">{{t('file_type')}}</label><select id="folder-type" v-model="newFolderType"><option value="img">{{t('images')}}</option><option value="other">{{t('documents_and_other_files')}}</option></select></template><p v-if="addError" class="link-error" role="alert">{{addError}}</p></div><div class="form-footer"><button type="button" @click="addKind=''">{{t('cancel')}}</button><button class="primary" type="submit">{{t('add')}}</button></div></form></section></div>
 <div class="overlay" v-if="templatesOpen" @click.self="templatesOpen=false"><section class="confirm-card template-dialog" role="dialog" aria-modal="true" :aria-label="t('tpl_from_template')" @keydown.esc.prevent="templatesOpen=false"><TemplatePicker dialog :token="token" :schema-revision="schemaRevision" :readonly="readonly" @created="templatesCreated" @cancel="templatesOpen=false"/></section></div><div class="overlay" v-if="leaveOpen"><section class="confirm-card" role="dialog" aria-modal="true" :aria-label="t('unsaved_changes')"><h2>{{t('save_changes_2')}}</h2><p>{{t('the_structure_has_unsaved_changes_save_them')}}</p><div class="form-footer"><button @click="chooseLeave('cancel')">{{t('cancel_2')}}</button><button @click="chooseLeave('discard')">{{t('discard_edits')}}</button><button class="primary" @click="chooseLeave('save')">{{t('save_step')}}</button></div></section></div>
</div>`;
export default {
  template,
  props: ['schema', 'schemaRevision', 'token', 'name', 'readonly', 'contentHref'],
  emits: ['saved', 'dirty', 'back', 'navigate'],
  setup(props: any, { emit, expose }: any) {
    const clone = (v: any) => JSON.parse(JSON.stringify(v));
    function normalized(schema: Schema) {
      const draft = clone(schema);
      draft.folders ??= {};
      for (const def of Object.values(draft.lists) as any[]) {
        def.group ??= [];
        for (const field of Object.values(def.columns) as Field[]) {
          field.width ??= 'full';
          if (field.type === 'long_text') field.type = 'textarea';
          if (field.type === 'short_text') field.type = 'text';
        }
      }
      return draft as Schema;
    }
    const state = reactive({
      leaveOpen: false,
      draft: normalized(props.schema),
      original: '',
      selected: Object.keys(props.schema.lists)[0] || '',
      selectedFolder: Object.keys(props.schema.folders || {})[0] || '',
      tab: 'collections',
      expandedField: '',
      orderKind: '',
      orderFrom: '',
      orderTarget: '',
      orderSide: 'before',
      busy: false,
      notice: '',
      noticeKind: 'success',
      addKind: '',
      templatesOpen: false,
      newName: '',
      newCode: '',
      newType: 'text',
      newFolderType: 'img',
      addError: '',
      confirmation: '',
    });
    state.original = JSON.stringify(state.draft);
    const dirty = computed(() => JSON.stringify(state.draft) !== state.original),
      definition = computed(() => state.draft.lists[state.selected]),
      folderDefinition = computed(() => state.draft.folders?.[state.selectedFolder]);
    const displayFields = computed(() =>
      typeof definition.value?.display === 'string' ? [definition.value.display] : definition.value?.display || [],
    );
    watch(
      () => state.selected,
      () => (state.expandedField = ''),
    );
    watch(dirty, (value) => emit('dirty', value), { immediate: true });
    watch(
      () => props.schemaRevision,
      () => {
        state.draft = normalized(props.schema);
        state.original = JSON.stringify(state.draft);
        if (!Object.hasOwn(state.draft.lists, state.selected)) state.selected = Object.keys(state.draft.lists)[0] || '';
        if (!Object.hasOwn(state.draft.folders || {}, state.selectedFolder))
          state.selectedFolder = Object.keys(state.draft.folders || {})[0] || '';
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The app's one confirm dialog (packages/ui); state.confirmation says a question is open.
    async function ask(text: string) {
      state.confirmation = localize(text);
      try {
        return await confirmDialog({
          title: t('confirm_action_2'),
          message: state.confirmation,
          confirm: t('confirm'),
          cancel: t('cancel'),
          label: t('confirm_structure_change'),
        });
      } finally {
        state.confirmation = '';
      }
    }
    function notify(text: string, kind = 'success') {
      clearTimeout(timer);
      state.notice = localize(text);
      state.noticeKind = kind;
      timer = setTimeout(() => (state.notice = ''), kind === 'error' ? 9000 : 4000);
    }
    async function openAdd(kind: string) {
      state.addKind = kind;
      state.newName = '';
      state.newCode = '';
      state.newType = 'text';
      state.addError = '';
      await nextTick();
      document.getElementById('structure-name')?.focus();
    }
    function add() {
      const key = state.newCode.trim(),
        name = state.newName.trim();
      if (!/^[a-zA-Z][\w-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) {
        state.addError = t('enter_a_valid_code');
        return;
      }
      const target =
        state.addKind === 'collection'
          ? state.draft.lists
          : state.addKind === 'folder'
            ? state.draft.folders!
            : definition.value!.columns;
      if (Object.hasOwn(target, key)) {
        state.addError = t('this_code_already_exists');
        return;
      }
      if (state.addKind === 'collection') {
        state.draft.lists[key] = {
          label: name,
          key: 'code',
          display: 'title',
          group: [],
          columns: {
            code: {
              type: 'generated',
              label: t('code'),
              readonly: true,
              required: true,
              width: 'half',
              valuePattern: key + '-####',
            },
            title: { type: 'text', label: t('name'), width: 'half' },
          },
        };
        state.selected = key;
        state.expandedField = '';
        state.tab = 'collections';
      } else if (state.addKind === 'field') {
        state.expandedField = key;
        definition.value!.columns[key] = {
          label: name,
          type: state.newType,
          width: 'full',
          ...(state.newType === 'generated'
            ? { readonly: true, valuePattern: state.selected + '-####' }
            : state.newType === 'checkbox'
              ? { default: 'false' }
              : {}),
          ...(state.newType === 'list'
            ? { list: '' }
            : ['file', 'media'].includes(state.newType)
              ? { folder: '' }
              : {}),
        };
      } else {
        state.draft.folders![key] = { label: name, type: state.newFolderType as 'img' | 'other' };
        state.selectedFolder = key;
      }
      state.addKind = '';
    }
    function toggleDisplay(key: string, checked: boolean) {
      const fields = displayFields.value.filter((k) => k !== key);
      if (checked) fields.push(key);
      definition.value!.display = fields;
    }
    // A read-only field can still be filled in when a record is created: always for ordinary fields, by choice for a
    // generated value (otherwise the server assigns it).
    function setEditableOnCreate(field: Field, checked: boolean) {
      if (checked) field.editableOnCreate = true;
      else delete field.editableOnCreate;
    }
    function readonlyChanged(field: Field) {
      if (!field.readonly) delete field.editableOnCreate;
    }
    function fieldTypeChanged(field: Field) {
      if (field.type === 'generated') {
        field.readonly = true;
        field.valuePattern ??= state.selected + '-####';
        delete field.default;
      } else {
        delete field.valuePattern;
        delete field.editableOnCreate;
      }
      if (field.type === 'checkbox' && !['true', 'false'].includes(field.default || '')) field.default = 'false';
      if (!defaultValueTypes.includes(field.type)) delete field.default;
      if (!['text', 'short_text', 'textarea', 'long_text'].includes(field.type)) delete field.pattern;
      if (field.type === 'file') field.folder ??= '';
      if (field.type === 'list') field.list ??= '';
    }
    // The folder's largest file in MB; empty = the default from the code (20 MB). The server validates 1–100.
    function setFolderLimit(folder: { maxSizeMb?: number }, value: string) {
      const number = Number(value);
      if (value === '' || !Number.isFinite(number)) delete folder.maxSizeMb;
      else folder.maxSizeMb = number;
    }
    // An empty default is no default.
    function setDefault(field: Field, value: string) {
      if (value === '') delete field.default;
      else field.default = value;
    }
    // HTML content is suppressed: offered only to a field that already has it.
    function offeredTypes(current: string) {
      return Object.fromEntries(Object.entries(types).filter(([type]) => type !== 'html' || current === 'html'));
    }
    function setPattern(field: Field, value: string) {
      if (!value) delete field.pattern;
      else field.pattern = value;
    }

    let orderPointer: { kind: string; key: string; x: number; y: number; id: number } | null = null;
    function orderClasses(kind: string, key: string) {
      return {
        ordering: state.orderKind === kind && state.orderFrom === key,
        'order-before': state.orderKind === kind && state.orderTarget === key && state.orderSide === 'before',
        'order-after': state.orderKind === kind && state.orderTarget === key && state.orderSide === 'after',
      };
    }
    function endOrderDrag() {
      orderPointer = null;
      state.orderKind = '';
      state.orderFrom = '';
      state.orderTarget = '';
    }
    function startOrderDrag(kind: string, key: string, event: PointerEvent) {
      if (state.busy || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.focus();
      orderPointer = { kind, key, x: event.clientX, y: event.clientY, id: event.pointerId };
      handle.setPointerCapture(event.pointerId);
    }
    function moveOrderDrag(event: PointerEvent) {
      if (!orderPointer || orderPointer.id !== event.pointerId) return;
      if (!state.orderFrom && Math.hypot(event.clientX - orderPointer.x, event.clientY - orderPointer.y) < 5) return;
      state.orderKind = orderPointer.kind;
      state.orderFrom = orderPointer.key;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-order-kind]');
      if (!row || row.dataset.orderKind !== orderPointer.kind) {
        state.orderTarget = '';
        return;
      }
      state.orderTarget = row.dataset.orderKey!;
      const head = row.querySelector('.field-heading') || row,
        box = head.getBoundingClientRect();
      state.orderSide = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    }
    function orderSource(kind: string): Record<string, any> {
      return kind === 'collections'
        ? state.draft.lists
        : kind === 'folders'
          ? state.draft.folders!
          : definition.value!.columns;
    }
    function applyOrder(kind: string, key: string, target: string, after: boolean) {
      const source = orderSource(kind),
        entries = Object.entries(source),
        from = entries.findIndex(([id]) => id === key),
        index = entries.findIndex(([id]) => id === target);
      if (index < 0) return;
      const result = Object.fromEntries(reorder(entries, from, index + (after ? 1 : 0)));
      if (kind === 'collections') state.draft.lists = result as Schema['lists'];
      else if (kind === 'folders') state.draft.folders = result as Schema['folders'];
      else definition.value!.columns = result as Record<string, Field>;
    }
    function dropOrderDrag(event: PointerEvent) {
      const kind = state.orderKind,
        key = state.orderFrom,
        target = state.orderTarget,
        after = state.orderSide === 'after';
      endOrderDrag();
      const handle = event.currentTarget as HTMLElement;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (kind && key && target) applyOrder(kind, key, target, after);
    }
    function keyboardOrder(kind: string, key: string, delta: number) {
      const keys = Object.keys(orderSource(kind)),
        index = keys.indexOf(key),
        target = keys[index + delta];
      if (target) applyOrder(kind, key, target, delta > 0);
    }
    async function removeField(key: string) {
      const def = definition.value!;
      if (key === def.key) {
        notify(t('first_select_another_unique_key_for_the'), 'error');
        return;
      }
      if (!(await ask(`Odstranit pole „${def.columns[key].label}“ ze struktury? Úprava se projeví až po uložení.`)))
        return;
      delete def.columns[key];
      def.group = def.group?.filter((k) => k !== key);
      def.display = displayFields.value.filter((k) => k !== key);
    }
    async function removeCollection() {
      const def = definition.value,
        key = state.selected;
      if (!def || state.busy) return;
      const refs = Object.entries(state.draft.lists).flatMap(([name, list]) =>
        name === key
          ? []
          : Object.values(list.columns)
              .filter((f) => f.type === 'list' && f.list === key)
              .map((f) => list.label + ' / ' + f.label),
      );
      if (refs.length) {
        notify(t('cannot_delete_the_collection_it_is_referenced') + ' ' + refs.join('; '), 'error');
        return;
      }
      if (Object.hasOwn(props.schema.lists, key)) {
        state.busy = true;
        try {
          const response = await fetch(appPath('/api/collection-removal?collection=' + encodeURIComponent(key)));
          const result = await response.json();
          if (!response.ok) throw Error(result.error);
          if (result.count) {
            notify('Kolekce „' + def.label + '“ obsahuje ' + result.count + ' záznamů a nelze ji odstranit.', 'error');
            return;
          }
        } catch (e: any) {
          notify(e.message, 'error');
          return;
        } finally {
          state.busy = false;
        }
      }
      if (!(await ask('Odstranit kolekci „' + def.label + '“ ze struktury?'))) return;
      delete state.draft.lists[key];
      state.selected = Object.keys(state.draft.lists)[0] || '';
    }
    async function removeFolder(key: string) {
      // A folder that a field uses stays; the same rule the server keeps.
      for (const list of Object.values(state.draft.lists) as any[])
        for (const field of Object.values(list.columns) as any[])
          if (['file', 'media'].includes(field.type) && field.folder === key)
            return notify(
              t('folder_in_use', { folder: state.draft.folders![key].label, list: list.label, field: field.label }),
              'error',
            );
      if (
        await ask(
          `Odstranit složku „${state.draft.folders![key].label}“ ze struktury? Složku se soubory nelze odstranit.`,
        )
      ) {
        delete state.draft.folders![key];
        state.selectedFolder = Object.keys(state.draft.folders || {})[0] || '';
      }
    }
    async function reset() {
      if (!dirty.value || (await ask(t('discard_unsaved_structure_changes')))) {
        state.draft = normalized(props.schema);
        state.original = JSON.stringify(state.draft);
        state.selected = Object.keys(state.draft.lists)[0] || '';
        if (!Object.hasOwn(state.draft.folders || {}, state.selectedFolder))
          state.selectedFolder = Object.keys(state.draft.folders || {})[0] || '';
      }
    }
    async function back() {
      if (await canLeave()) emit('back');
    }
    async function save() {
      if (props.readonly || state.busy || !dirty.value || state.addKind || state.confirmation) return false;
      state.busy = true;
      try {
        const response = await fetch(appPath('/api/structure'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CMS-Token': props.token },
          body: JSON.stringify({ schema: state.draft, revision: props.schemaRevision }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || t('the_structure_could_not_be_saved'));
        emit('saved', result);
        notify(
          result.publicationWarning || t('structure_was_saved_content_forms_were_updated'),
          result.publicationWarning ? 'error' : 'success',
        );
        return true;
      } catch (e: any) {
        notify(e.message, 'error');
        return false;
      } finally {
        state.busy = false;
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
      return new Promise<boolean>((resolve) => (leaveResolve = resolve));
    }
    // Templates from the Structure editor: written on the server in one step, then the saved structure comes back.
    function templatesCreated(result: any) {
      state.templatesOpen = false;
      emit('saved', result);
      notify(t('tpl_created'));
    }
    expose({ save, canLeave });
    return {
      t,
      chooseLeave,
      appBase,
      ...Object.fromEntries(
        Object.keys(state).map((k) => [
          k,
          computed({ get: () => state[k as keyof typeof state], set: (v) => ((state as any)[k] = v) }),
        ]),
      ),
      definition,
      folderDefinition,
      dirty,
      templatesCreated,
      displayFields,
      types,
      fieldTypeChanged,
      openAdd,
      add,
      toggleDisplay,
      setPattern,
      offeredTypes,
      setEditableOnCreate,
      setDefault,
      defaultValueTypes,
      readonlyChanged,
      setFolderLimit,
      orderClasses,
      startOrderDrag,
      moveOrderDrag,
      dropOrderDrag,
      endOrderDrag,
      keyboardOrder,
      removeField,
      removeCollection,
      removeFolder,
      save,
      reset,
      back,
    };
  },
};
