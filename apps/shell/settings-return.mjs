export function settingsReturnTo(value) {
  if (typeof value !== 'string' || !/^\/(content|site)(\/|$)/.test(value) || /[\\\u0000-\u0020\u007f]/.test(value))
    return '/content/';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u0020\u007f]/.test(decoded)) return '/content/';
    const url = new URL(value, 'http://shell.local');
    if (url.origin !== 'http://shell.local' || !/^\/(content|site)(\/|$)/.test(url.pathname)) return '/content/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/content/';
  }
}
