// Applies day or night before the page is painted (the toolbar toggle switches them; the choice stays in this
// browser). Night is the black studio look. Day takes the environment colours from the Shared settings
// (data-day-palette → data-studio-palette), or the studio's own light look when there are none.
window.sitetillerApplyTheme = (day) => {
  const root = document.documentElement,
    palette = root.dataset.dayPalette;
  if (day && palette) root.dataset.studioPalette = palette;
  else delete root.dataset.studioPalette;
  const theme = day ? (palette && palette !== 'light' ? 'dark' : 'light') : 'dark';
  root.dataset.theme = theme;
  root.dataset.dayNight = day ? 'day' : 'night';
  root.style.colorScheme = theme;
};
(() => {
  let day = false;
  try {
    day = localStorage.getItem('sitetiller-theme') === 'light';
  } catch {}
  window.sitetillerApplyTheme(day);
})();
