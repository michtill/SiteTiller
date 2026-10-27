// Applies the colour mode of the Shared settings (data-mode, documentation 2.4) before the page is painted: Light is
// the editor's light look, Dark the black studio look. The toolbar's sun/moon switches it only for a while, to judge
// the preview in a light or dark surround; it is not remembered, so the next opening follows the settings again.
window.sitetillerApplyTheme = (day) => {
  const root = document.documentElement;
  if (day) root.dataset.studioPalette = 'light';
  else delete root.dataset.studioPalette;
  const theme = day ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.dataset.dayNight = day ? 'day' : 'night';
  root.style.colorScheme = theme;
};
window.sitetillerApplyTheme(document.documentElement.dataset.mode === 'light');
