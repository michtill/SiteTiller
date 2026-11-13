import { t } from './i18n.ts';
// The labels of the completeness check (documentation 4.11): a group, a rule and the state of an external link.
export const groupLabel = (id: string) => t(`cc_group_${id}`);
export const ruleLabel = (id: string) => t(`cc_${id}`);
export const linkLabel = (state: string) => t(`link_${state}`);
const page = (path: string) => path.replace(/^site\//, '');
const where = (item: any) =>
  item.pages
    ? t(item.id === 'image_size' ? 'completeness_files' : 'completeness_pages', { pages: item.pages.map(page).join(', ') })
    : '';
// A rule not met as one line of a step's warnings, and the request Fix in AI Studio prefills with it.
export const completenessText = (item: any) =>
  groupLabel(item.group) + ': ' + ruleLabel(item.id) + (item.pages ? ' (' + item.pages.map(page).join(', ') + ')' : '');
export const completenessFixPrompt = (item: any) =>
  t('completeness_fix_prompt', {
    rule: ruleLabel(item.id),
    detail: [item.detail, where(item)]
      .filter(Boolean)
      .map((text: string) => ' ' + text)
      .join(''),
  });
