import { s, api, notice, refresh, selectionKey, selectionUrl, type Selection } from './studio.ts';
import { t } from './i18n.ts';
// The preview iframes live outside Vue: a new page loads in a hidden frame and replaces the visible one only
// when it reported its title, and the last displayed previews stay alive behind it, so returning to one is
// instant and keeps the page, scroll position and form state the user left there.
let container: HTMLElement;
const keptPreviews = new Map<string, HTMLIFrameElement>(),
  previewMeta = new WeakMap<
    HTMLIFrameElement,
    { key: string; title: string; url: string; selection: Selection; signature: string }
  >(),
  savedPreviewAccess = new Map<string, { url: string; expires: number }>(),
  keptPreviewLimit = 4;
let previewRequest = 0,
  pendingPreviewFrame: HTMLIFrameElement | null = null,
  previewCancel: (() => void) | null = null;
const visible = () => document.getElementById('preview') as HTMLIFrameElement;
export function mountPreview(element: HTMLElement) {
  container = element;
  const frame = document.createElement('iframe');
  frame.id = 'preview';
  frame.title = t('website_draft_preview');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  container.append(frame);
}
function keepPreview(frame: HTMLIFrameElement) {
  const meta = previewMeta.get(frame);
  if (!meta) {
    frame.remove();
    return;
  }
  frame.removeAttribute('id');
  frame.classList.add('kept-preview');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  keptPreviews.delete(meta.key);
  keptPreviews.set(meta.key, frame);
  while (keptPreviews.size > keptPreviewLimit) {
    const [oldest, old] = keptPreviews.entries().next().value!;
    keptPreviews.delete(oldest);
    old.remove();
  }
}
function discardKeptPreview(key: string) {
  keptPreviews.get(key)?.remove();
  keptPreviews.delete(key);
}
function settle() {
  s.previewPending = false;
  s.previewPendingKey = null;
  s.pendingSelection = null;
  container.removeAttribute('aria-busy');
}
function show(selection: Selection, url: string, title: string) {
  s.displayedSelection = selection;
  // Open shows the page on its own, with its corner "i" (documentation 4.3): without the studio's frame parameters.
  const open = new URL(url, location.href);
  open.searchParams.delete('embedded');
  open.searchParams.delete('refresh');
  s.openPreviewHref = open.href;
  s.projectTitle = title || t('website');
  s.projectTitleHint = title;
  s.historicalPreview = selection.historical;
}
// The live draft is reused only while the content editor state it showed is unchanged.
function showKeptPreview(key: string) {
  const frame = keptPreviews.get(key),
    meta = frame && previewMeta.get(frame);
  if (!frame || !meta) return false;
  keptPreviews.delete(key);
  const selection = meta.selection,
    live = !selection.historical && selection.kind !== 'saved' && selection.kind !== 'release';
  if (live && meta.signature !== s.current.contentSignature) {
    frame.remove();
    return false;
  }
  ++previewRequest;
  previewCancel?.();
  previewCancel = null;
  pendingPreviewFrame?.remove();
  pendingPreviewFrame = null;
  const old = visible();
  frame.id = 'preview';
  frame.classList.remove('kept-preview');
  frame.removeAttribute('aria-hidden');
  frame.removeAttribute('tabindex');
  keepPreview(old);
  show(selection, meta.url, meta.title);
  s.previewFailedKey = null;
  settle();
  void refresh(s.current);
  return true;
}
export async function selectPreviewTarget(selection: Selection, force = false, follow = false): Promise<boolean> {
  s.previewFollowCurrent = follow;
  const key = selectionKey(selection);
  if (s.previewPending && key === s.previewPendingKey) return false;
  if (force) discardKeptPreview(key);
  else if (key !== selectionKey(s.displayedSelection || {}) && showKeptPreview(key)) return true;
  if (!force && key === selectionKey(s.displayedSelection || {})) {
    if (s.previewPending) {
      ++previewRequest;
      previewCancel?.();
      pendingPreviewFrame?.remove();
      pendingPreviewFrame = null;
      settle();
    }
    return true;
  }
  const request = ++previewRequest;
  previewCancel?.();
  s.previewPending = true;
  s.previewPendingKey = key;
  s.pendingSelection = { ...selection };
  s.previewFailedKey = null;
  pendingPreviewFrame?.remove();
  pendingPreviewFrame = null;
  container.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  previewCancel = () => controller.abort();
  let frame: HTMLIFrameElement | undefined;
  try {
    if (selection.kind === 'saved') {
      let access = savedPreviewAccess.get(selection.id!);
      if (!access || access.expires - Date.now() < 60000) {
        access = await api(
          'drafts/preview',
          { id: selection.id },
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        if (request !== previewRequest) return false;
        savedPreviewAccess.set(selection.id!, access!);
      }
      const target = new URL(s.current.previewUrl, location.href);
      target.pathname = target.pathname.replace(/\/?$/, '/') + access!.url.replace(/^\/preview\//, '');
      selection = { ...selection, savedUrl: target.href };
    }
    const url = selectionUrl(selection);
    url.searchParams.set('embedded', '1');
    if (force) url.searchParams.set('refresh', String(Date.now()));
    if (url.origin === location.origin) {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok || (response.redirected && !response.url.startsWith(url.origin + '/preview')))
        throw Error(t('preview_load_failed'));
    }
    if (request !== previewRequest) return false;
    const loading = visible().cloneNode(false) as HTMLIFrameElement;
    frame = loading;
    loading.removeAttribute('id');
    loading.removeAttribute('src');
    loading.classList.add('pending-preview');
    loading.setAttribute('aria-hidden', 'true');
    loading.tabIndex = -1;
    loading.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-modals allow-downloads' +
        (url.origin !== location.origin ? ' allow-same-origin' : ''),
    );
    pendingPreviewFrame = loading;
    let loadedTitle = '';
    await new Promise<void>((resolve, reject) => {
      let loaded = false,
        reported = false;
      const clear = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', report);
        if (request === previewRequest) previewCancel = null;
      };
      const done = () => {
        if (loaded && reported) {
          clear();
          resolve();
        }
      };
      const report = (event: MessageEvent) => {
        if (
          event.source === loading.contentWindow &&
          event.data?.type === 'sitetiller-preview-title' &&
          event.data.commit === selection.commit &&
          typeof event.data.title === 'string'
        ) {
          reported = true;
          loadedTitle = event.data.title.trim().slice(0, 500);
          done();
        }
      };
      const timeout = setTimeout(() => {
        clear();
        reject(Error(t('preview_load_failed')));
      }, 15000);
      previewCancel = () => {
        controller.abort();
        clear();
        reject(Error('Cancelled preview selection'));
      };
      window.addEventListener('message', report);
      loading.addEventListener(
        'load',
        () => {
          loaded = true;
          done();
        },
        { once: true },
      );
      loading.addEventListener(
        'error',
        () => {
          clear();
          reject(Error(t('preview_load_failed')));
        },
        { once: true },
      );
      loading.src = url.href;
      container.append(loading);
    });
    if (request !== previewRequest) {
      loading.remove();
      return false;
    }
    const old = visible();
    loading.id = 'preview';
    loading.classList.remove('pending-preview');
    loading.removeAttribute('aria-hidden');
    loading.removeAttribute('tabindex');
    loading.dataset.commit = selection.commit;
    loading.dataset.previewKey = key;
    previewMeta.set(loading, {
      key,
      title: loadedTitle,
      url: url.href,
      selection,
      signature: s.current.contentSignature,
    });
    keepPreview(old);
    pendingPreviewFrame = null;
    show(selection, url.href, loadedTitle);
    settle();
    await refresh(s.current);
    return true;
  } catch {
    frame?.remove();
    if (request === previewRequest) {
      pendingPreviewFrame = null;
      settle();
      s.previewFailedKey = key;
      notice(t('preview_load_failed'));
    }
    return false;
  } finally {
    if (request === previewRequest) previewCancel = null;
  }
}
// The page in the preview gets the scrollbar colours of the studio's colour mode (documentation 2.4): when it loads
// (it reports its title) and whenever the mode changes.
function scrollbarColours(target: Window) {
  const style = getComputedStyle(document.documentElement);
  target.postMessage(
    {
      type: 'sitetiller-preview-scrollbar',
      mode: document.documentElement.dataset.dayNight === 'day' ? 'light' : 'dark',
      thumb: style.getPropertyValue('--ui-scroll').trim(),
      track: style.getPropertyValue('--ui-page').trim(),
    },
    '*',
  );
}
new MutationObserver(() => {
  for (const frame of container?.querySelectorAll('iframe') || [])
    if (frame.contentWindow) scrollbarColours(frame.contentWindow);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-day-night'] });
// Kept previews remember the latest title of the page shown in them; the visible one also updates the toolbar.
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'sitetiller-preview-title' || typeof event.data.title !== 'string') return;
  const title = event.data.title.trim().slice(0, 500);
  for (const frame of container?.querySelectorAll('iframe') || [])
    if (frame.contentWindow === event.source) {
      const meta = previewMeta.get(frame);
      if (meta) meta.title = title;
      scrollbarColours(frame.contentWindow);
    }
  if (
    s.current &&
    event.source === visible()?.contentWindow &&
    event.data.commit === (s.displayedSelection?.commit || s.current.head)
  ) {
    s.projectTitle = title || t('website');
    s.projectTitleHint = title || t('website');
  }
});
