import { t } from './i18n.ts';
// The labels of the completeness check (documentation 4.11): a group, a rule and the state of an external link.
export const groupLabel = (id: string) => t(`cc_group_${id}`);
export const ruleLabel = (id: string) => t(`cc_${id}`);
export const linkLabel = (state: string) => t(`link_${state}`);
