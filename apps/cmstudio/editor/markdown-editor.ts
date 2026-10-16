// Formatted content (Markdown): written as formatted text, stored as Markdown. Blocks come from "+" or "/" in the
// text; images come from the content folders. "Source" shows and edits the plain Markdown.
import { ref, shallowRef, watch, onMounted, onBeforeUnmount, computed } from 'vue';
import { Editor, EditorContent } from '@tiptap/vue-3';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Markdown } from '@tiptap/markdown';
import Suggestion from '@tiptap/suggestion';
import { t } from './i18n.ts';
type ImageFolder = { folder: string; label: string; files: string[] };
type Block = { id: string; label: string; hint: string; run: (editor: Editor) => void };
const template = `<div class="markdown-editor" :class="{readonly,focused}" :data-field="label">
<div class="markdown-tools" v-if="!readonly" role="toolbar" :aria-label="label">
<button type="button" class="md-tool" :class="{active:active.bold}" :disabled="source" :aria-label="t('bold')" :title="t('bold')" @mousedown.prevent="run(e=>e.chain().focus().toggleBold().run())"><b>B</b></button>
<button type="button" class="md-tool" :class="{active:active.italic}" :disabled="source" :aria-label="t('italic')" :title="t('italic')" @mousedown.prevent="run(e=>e.chain().focus().toggleItalic().run())"><i>I</i></button>
<button type="button" class="md-tool" :class="{active:active.link}" :disabled="source" :aria-label="t('link')" :title="t('link')" @mousedown.prevent="editLink">🔗</button>
<span class="md-separator" aria-hidden="true"></span>
<div class="md-insert"><button type="button" class="md-tool" :disabled="source" :aria-expanded="String(menu==='plus')" :aria-label="t('md_insert_block')" :title="t('md_insert_block')" @mousedown.prevent="menu=menu==='plus'?'':'plus'">+</button>
<div v-if="menu==='plus'" class="md-menu" role="menu"><button v-for="block in blocks" type="button" role="menuitem" @mousedown.prevent="choose(block)"><strong>{{block.label}}</strong><small>{{block.hint}}</small></button></div></div>
<template v-if="active.table"><span class="md-separator" aria-hidden="true"></span><button type="button" class="md-tool md-text" @mousedown.prevent="run(e=>e.chain().focus().addRowAfter().run())">{{t('md_add_row')}}</button><button type="button" class="md-tool md-text" @mousedown.prevent="run(e=>e.chain().focus().addColumnAfter().run())">{{t('md_add_column')}}</button><button type="button" class="md-tool md-text" @mousedown.prevent="run(e=>e.chain().focus().deleteRow().run())">{{t('md_delete_row')}}</button><button type="button" class="md-tool md-text" @mousedown.prevent="run(e=>e.chain().focus().deleteColumn().run())">{{t('md_delete_column')}}</button><button type="button" class="md-tool md-text" @mousedown.prevent="run(e=>e.chain().focus().deleteTable().run())">{{t('md_delete_table')}}</button></template>
<button type="button" class="md-tool md-text md-source" :aria-pressed="String(source)" @click="toggleSource">{{source?t('md_formatted'):t('md_source')}}</button>
</div>
<textarea v-if="source" class="markdown-source" :readonly="readonly" :value="text" @input="sourceInput($event.target.value)" :aria-label="label+' — Markdown'" rows="14"></textarea>
<EditorContent v-else :editor="editor" class="markdown-content" />
<div v-if="menu==='slash'&&slashItems.length" class="md-menu md-slash" role="listbox" :style="slashStyle"><button v-for="(block,index) in slashItems" type="button" role="option" :aria-selected="String(index===slashIndex)" :class="{active:index===slashIndex}" @mousedown.prevent="slashChoose(block)"><strong>{{block.label}}</strong><small>{{block.hint}}</small></button></div>
<div class="overlay" v-if="picking" @click.self="picking=false"><section class="picker" role="dialog" aria-modal="true" :aria-label="t('md_insert_image')"><div class="picker-head"><h2>{{t('md_insert_image')}}</h2><button type="button" @click="picking=false">{{t('close')}}</button></div><div class="md-folder-tabs" v-if="images.length>1"><button v-for="item in images" type="button" :aria-pressed="String(item.folder===pickFolder)" @click="pickFolder=item.folder">{{item.label}}</button></div><div class="media-grid"><button v-for="path in pickFiles" type="button" @click="insertImage(path)"><img :src="mediaUrl(path)" :alt="path" loading="lazy"><small>{{path.split('/').at(-1)}}</small></button></div><p v-if="!pickFiles.length" class="empty">{{t('there_are_no_files_in_this_folder')}}</p></section></div>
</div>`;
export default {
  template,
  components: { EditorContent },
  props: {
    modelValue: { type: String, default: '' },
    readonly: { type: Boolean, default: false },
    label: { type: String, default: '' },
    images: { type: Array as () => ImageFolder[], default: () => [] },
    mediaUrl: { type: Function, default: (path: string) => path },
  },
  emits: ['update:modelValue'],
  setup(props: any, { emit }: any) {
    const editor = shallowRef<Editor | null>(null),
      text = ref(props.modelValue || ''),
      source = ref(false),
      focused = ref(false),
      menu = ref(''),
      picking = ref(false),
      pickFolder = ref(''),
      active = ref({ bold: false, italic: false, link: false, table: false }),
      slashItems = ref<Block[]>([]),
      slashIndex = ref(0),
      slashStyle = ref<Record<string, string>>({});
    let slashCommand: ((block: Block) => void) | null = null;
    const blocks = computed<Block[]>(() => [
      {
        id: 'h2',
        label: t('md_heading_2'),
        hint: '## ',
        run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
      },
      {
        id: 'h3',
        label: t('md_heading_3'),
        hint: '### ',
        run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
      },
      {
        id: 'h4',
        label: t('md_heading_4'),
        hint: '#### ',
        run: (e) => e.chain().focus().toggleHeading({ level: 4 }).run(),
      },
      {
        id: 'bullets',
        label: t('md_bulleted_list'),
        hint: '- ',
        run: (e) => e.chain().focus().toggleBulletList().run(),
      },
      {
        id: 'numbers',
        label: t('md_numbered_list'),
        hint: '1. ',
        run: (e) => e.chain().focus().toggleOrderedList().run(),
      },
      { id: 'quote', label: t('md_quote'), hint: '> ', run: (e) => e.chain().focus().toggleBlockquote().run() },
      { id: 'divider', label: t('md_divider'), hint: '---', run: (e) => e.chain().focus().setHorizontalRule().run() },
      {
        id: 'table',
        label: t('md_table'),
        hint: '| |',
        run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      },
      ...(props.images.length
        ? [{ id: 'image', label: t('md_image_from_folder'), hint: '![ ]()', run: () => openImages() }]
        : []),
    ]);
    function run(command: (e: Editor) => void) {
      if (editor.value && !props.readonly) command(editor.value);
    }
    function choose(block: Block) {
      menu.value = '';
      run(block.run);
    }
    function openImages() {
      pickFolder.value = pickFolder.value || props.images[0]?.folder || '';
      picking.value = true;
    }
    const pickFiles = computed(() => props.images.find((i: ImageFolder) => i.folder === pickFolder.value)?.files || []);
    function insertImage(path: string) {
      picking.value = false;
      run((e) =>
        e
          .chain()
          .focus()
          .setImage({
            src: path,
            alt: path
              .split('/')
              .at(-1)!
              .replace(/\.[^.]+$/, ''),
          })
          .run(),
      );
    }
    function editLink() {
      run((e) => {
        const current = e.getAttributes('link').href || '';
        const href = window.prompt(t('md_link_address'), current);
        if (href === null) return;
        if (!href.trim()) e.chain().focus().extendMarkRange('link').unsetLink().run();
        else e.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
      });
    }
    // "/" in the text opens the same block menu, filtered by what follows it.
    const SlashMenu = Extension.create({
      name: 'slashMenu',
      addProseMirrorPlugins() {
        return [
          Suggestion({
            editor: this.editor,
            char: '/',
            allowSpaces: true,
            startOfLine: false,
            items: ({ query }) =>
              blocks.value.filter(
                (b) => !query || b.label.toLocaleLowerCase('cs').includes(query.toLocaleLowerCase('cs')),
              ),
            command: ({ editor: e, range, props: block }: any) => {
              e.chain().focus().deleteRange(range).run();
              (block as Block).run(e as Editor);
            },
            render: () => ({
              onStart: (p: any) => show(p),
              onUpdate: (p: any) => show(p),
              onKeyDown: ({ event }: any) => {
                if (menu.value !== 'slash' || !slashItems.value.length) return false;
                if (event.key === 'ArrowDown') slashIndex.value = (slashIndex.value + 1) % slashItems.value.length;
                else if (event.key === 'ArrowUp')
                  slashIndex.value = (slashIndex.value - 1 + slashItems.value.length) % slashItems.value.length;
                else if (event.key === 'Enter') slashChoose(slashItems.value[slashIndex.value]);
                else if (event.key === 'Escape') menu.value = '';
                else return false;
                return true;
              },
              onExit: () => {
                if (menu.value === 'slash') menu.value = '';
              },
            }),
          }),
        ];
      },
    });
    function show(p: any) {
      slashItems.value = p.items;
      slashIndex.value = Math.min(slashIndex.value, Math.max(0, p.items.length - 1));
      slashCommand = p.command;
      const rect = p.clientRect?.(),
        host = (p.editor.view.dom as HTMLElement).closest('.markdown-editor')!.getBoundingClientRect();
      if (rect) slashStyle.value = { left: rect.left - host.left + 'px', top: rect.bottom - host.top + 4 + 'px' };
      menu.value = p.items.length ? 'slash' : '';
    }
    function slashChoose(block: Block) {
      menu.value = '';
      slashCommand?.(block);
    }
    // Images show from the content folders; the Markdown keeps the folder/file path.
    const ContentImage = Image.extend({
      renderHTML({ HTMLAttributes }) {
        return ['img', { ...HTMLAttributes, src: props.mediaUrl(HTMLAttributes.src || '') }];
      },
    });
    let lastEmitted = text.value;
    function emitValue(value: string) {
      lastEmitted = value;
      text.value = value;
      emit('update:modelValue', value);
    }
    function refreshActive(e: Editor) {
      active.value = {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        link: e.isActive('link'),
        table: e.isActive('table'),
      };
    }
    onMounted(() => {
      editor.value = new Editor({
        extensions: [
          StarterKit.configure({
            heading: { levels: [2, 3, 4] },
            code: false,
            codeBlock: false,
            strike: false,
            underline: false,
            link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tel'] },
          }),
          TableKit.configure({ table: { resizable: false } }),
          ContentImage,
          Markdown,
          SlashMenu,
        ],
        content: text.value,
        contentType: 'markdown',
        editable: !props.readonly,
        onUpdate: ({ editor: e }) => emitValue((e as any).getMarkdown()),
        onSelectionUpdate: ({ editor: e }) => refreshActive(e as Editor),
        onTransaction: ({ editor: e }) => refreshActive(e as Editor),
        onFocus: () => (focused.value = true),
        onBlur: () => {
          focused.value = false;
          if (menu.value === 'plus') menu.value = '';
        },
      } as any);
    });
    onBeforeUnmount(() => editor.value?.destroy());
    // Another record, a discarded edit or a reload: the editor takes the new value.
    watch(
      () => props.modelValue,
      (value) => {
        if ((value || '') === lastEmitted) return;
        lastEmitted = value || '';
        text.value = lastEmitted;
        (editor.value as any)?.commands.setContent(lastEmitted, { contentType: 'markdown', emitUpdate: false });
      },
    );
    watch(
      () => props.readonly,
      (value) => editor.value?.setEditable(!value),
    );
    function toggleSource() {
      if (source.value)
        (editor.value as any)?.commands.setContent(text.value, { contentType: 'markdown', emitUpdate: false });
      source.value = !source.value;
      menu.value = '';
    }
    function sourceInput(value: string) {
      emitValue(value);
    }
    return {
      t,
      editor,
      text,
      source,
      focused,
      menu,
      blocks,
      active,
      run,
      choose,
      editLink,
      toggleSource,
      sourceInput,
      slashItems,
      slashIndex,
      slashStyle,
      slashChoose,
      picking,
      pickFolder,
      pickFiles,
      insertImage,
    };
  },
};
