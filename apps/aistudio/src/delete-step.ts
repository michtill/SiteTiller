export function deleteStepTarget(config: any, id: string, head: string) {
  const steps = (config.requests || []).filter((r: any) => ['ready', 'legacy'].includes(r.status) && r.commit),
    latest = steps.at(-1);
  if (!latest || latest.id !== id || latest.commit !== head) throw Error('Poslední krok se mezitím změnil.');
  // The published step that opens the draft has nothing before it in the draft.
  if (latest.sequence <= (config.publishedThrough || 0) && (config.releases || []).some((r: any) => r.commit === head))
    throw Error('Publikovaný krok nelze odstranit.');
  const previous = steps.at(-2),
    commit = previous?.commit || latest.baseCommit || config.draftBaseCommit;
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Předchozí krok není dostupný.');
  return { commit, id: previous?.id, sequence: previous?.sequence ?? latest.sequence - 1, deleteStepId: latest.id };
}
