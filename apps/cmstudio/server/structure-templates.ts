import { createHash } from 'node:crypto';
import { translate } from '../../../packages/i18n/index.mjs';
import { Problem, type Schema, type Row } from './store.ts';
// Structure templates (documentation 3.9): a starting structure the user chooses, never created on its own. Names are
// in the interface language at the moment of creation, codes are the same for every language (0.3). Prepared entries
// have a code and a name, their values stay empty: places to fill in, nothing invented.
type Template = {
  id: string;
  lists: Schema['lists'];
  folders: NonNullable<Schema['folders']>;
  rows: Record<string, Row[]>;
};
export const templateIds = ['contacts', 'elements', 'pages', 'images'] as const;
function templates(language: string): Template[] {
  const t = (key: string) => translate('tpl_' + key, language);
  const images = { images: { label: t('images'), type: 'img' as const } };
  const prepared = (codes: string[]) => codes.map((code) => ({ code, name: t('item_' + code.replace(/-/g, '_')) }));
  return [
    {
      id: 'contacts',
      lists: {
        contacts: {
          label: t('contacts'),
          key: 'code',
          display: 'name',
          columns: {
            code: { label: t('code'), type: 'text', required: true, readonly: true },
            name: { label: t('name'), type: 'text' },
            value: { label: t('value'), type: 'text' },
          },
        },
      },
      folders: {},
      rows: { contacts: prepared(['name', 'email', 'phone', 'address', 'opening-hours', 'map']) },
    },
    {
      id: 'elements',
      lists: {
        elements: {
          label: t('elements'),
          key: 'code',
          display: 'name',
          columns: {
            code: { label: t('code'), type: 'text', required: true, readonly: true },
            name: { label: t('name'), type: 'text' },
            text: { label: t('text'), type: 'textarea' },
            image: { label: t('image'), type: 'file', folder: 'images' },
            content: { label: t('content'), type: 'markdown' },
          },
        },
      },
      folders: images,
      rows: { elements: prepared(['title', 'motto', 'main-photo', 'hero-text', 'footer']) },
    },
    {
      id: 'pages',
      lists: {
        pages: {
          label: t('pages'),
          key: 'slug',
          display: 'title',
          group: ['parent'],
          columns: {
            slug: { label: t('slug'), type: 'text', required: true, hint: t('slug_hint') },
            title: { label: t('title'), type: 'text', required: true },
            perex: { label: t('perex'), type: 'textarea' },
            content: { label: t('content'), type: 'markdown' },
            image: { label: t('image'), type: 'file', folder: 'images' },
            in_menu: { label: t('in_menu'), type: 'checkbox' },
            parent: { label: t('parent'), type: 'list', list: 'pages' },
          },
        },
      },
      folders: images,
      // The address is the page key, so the prepared Home page has one; the user may rewrite it.
      rows: { pages: [{ slug: 'home', title: t('item_home') }] },
    },
    { id: 'images', lists: {}, folders: images, rows: {} },
  ];
}
// What the offer shows: every template with its name, and whether its codes are still free.
export function templateOffer(schema: Schema, language: string) {
  return templates(language).map((template) => ({
    id: template.id,
    label: translate('tpl_offer_' + template.id, language),
    collections: Object.keys(template.lists),
    available: !Object.keys(template.lists).some((name) => Object.hasOwn(schema.lists, name)),
  }));
}
// The chosen templates as one structure change with its prepared entries, for writeDesignStructure. A code already
// used is refused with its reason; nothing existing is ever replaced.
export function applyTemplates(schema: Schema, ids: unknown, language: string) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !templateIds.includes(id)))
    throw new Problem(422, translate('tpl_choose', language));
  const chosen = templates(language).filter((template) => ids.includes(template.id)),
    next = structuredClone(schema),
    empty = createHash('sha256').update('[]\n').digest('hex'),
    changes: { collection: string; rows: Row[]; revision: string }[] = [];
  next.folders = next.folders || {};
  for (const template of chosen) {
    for (const [name, list] of Object.entries(template.lists)) {
      if (Object.hasOwn(next.lists, name))
        throw new Problem(409, translate('tpl_code_used', language, { name: next.lists[name].label, code: name }));
      next.lists[name] = list;
    }
    // A folder of the same code is shared (Pages and Prvky webu both use images), never replaced.
    for (const [name, folder] of Object.entries(template.folders))
      if (!Object.hasOwn(next.folders, name)) next.folders[name] = folder;
      else if (next.folders[name].type !== folder.type)
        throw new Problem(409, translate('tpl_code_used', language, { name: next.folders[name].label, code: name }));
    for (const [collection, rows] of Object.entries(template.rows)) changes.push({ collection, rows, revision: empty });
  }
  return { schema: next, changes };
}
