import { unpublishedRequests } from './publication-history.ts';
export async function draftState(project: any, config: any, head: string) {
  const published = config.publishedCommit;
  const contentChanged =
    !published || (await project.tree(head)) !== (config.publishedTree || (await project.tree(published)));
  const base = config.draftBaseCommit || published;
  return {
    contentChanged,
    hasUnpublishedWork:
      !!published && (head !== base || unpublishedRequests(config).length > 0 || !!config.pendingRelease),
  };
}
export function clearDraftHistory(config: any, head: string) {
  const through = Math.max(
    config.requestSequence || 0,
    config.reviewedThrough || 0,
    ...(config.requests || []).map((r: any) => r.sequence || 0),
  );
  config.requestSequence = through;
  config.reviewedThrough = through;
  config.publishedThrough = through;
  config.closedThrough = through;
  config.requests = [];
  config.pendingRelease = null;
  config.approvedCommit = null;
  config.technicalApproval = null;
  config.conversationMemory = [];
  config.lastReviewCommit = head;
  config.draftBaseCommit = head;
}
