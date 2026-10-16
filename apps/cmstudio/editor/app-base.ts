export function normalizeAppBase(value: string) {
  const base = value.trim().replace(/\/+$/, '');
  if (!base || base === '/') return '';
  if (!/^\/(?:[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) throw Error('Neplatná cesta aplikace.');
  return base;
}
// The app's path prefix: an explicit <meta name="app-base">, otherwise the address without the screen (/structure).
export const appBase = normalizeAppBase(
  typeof document === 'undefined'
    ? ''
    : document.querySelector<HTMLMetaElement>('meta[name="app-base"]')?.content ||
        location.pathname.replace(/\/structure\/?$/, '/'),
);
export function appPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) throw Error('Očekávána místní cesta aplikace.');
  return appBase + path;
}
export function structurePath(pathname: string) {
  return pathname.replace(/\/$/, '') === appPath('/structure');
}

export function commonSettingsPath(pathname: string, search: string) {
  const returnTo =
    pathname === '/content' ? '/content/' : pathname.startsWith('/content/') ? pathname : '/content' + pathname;
  return '/settings?returnTo=' + encodeURIComponent(returnTo + search);
}
