// The browser tab of every part of the application (documentation 2.2): "SiteTiller · <website name>", or only
// "SiteTiller" while the website has no name.
export function tabTitle(name) {
  const site = typeof name === 'string' ? name.trim() : '';
  return site && site !== 'SiteTiller' ? 'SiteTiller · ' + site : 'SiteTiller';
}
