// Dialogs register their openers here, so any part of the studio can open them.
export const dialogs = {
  saveDraft: () => {},
  restore: (_item: { commit: string; message: string; deleteStepId?: string }) => {},
  publish: () => {},
  share: () => {},
  reality: () => {},
  settings: () => {},
};
