// Shell frame: each studio is loaded once into its own iframe and stays alive while the user switches,
// so unsent requests, open forms and selections survive. Studios talk to the frame with postMessage:
//  sitetiller-navigate {href}  switch studio or leave the frame (settings, password, logout)
//  sitetiller-location {href}  the visible studio changed its own address
//  sitetiller-title {title}    the visible studio changed its title
// The frame tells each studio whether it is visible (sitetiller-visibility) and asks an already loaded
// studio to open a specific screen (sitetiller-open), e.g. AI settings or the structure editor.
(() => {
  const frames = {};
  const studioOf = (path) => (path.startsWith('/site') ? 'site' : 'content');
  const relative = (url) => url.pathname + url.search + url.hash;
  const post = (frame, message) => {
    try {
      frame.contentWindow.postMessage(message, location.origin);
    } catch {}
  };
  function syncTitle() {
    const visible = Object.values(frames).find((frame) => !frame.hidden);
    try {
      document.title = visible?.contentDocument?.title || 'SiteTiller';
    } catch {
      document.title = 'SiteTiller';
    }
  }
  function show(href, push) {
    const target = new URL(href, location.href),
      name = studioOf(target.pathname);
    let frame = frames[name];
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = name === 'site' ? 'AI Studio' : 'Editor obsahu';
      frame.src = relative(target);
      frame.addEventListener('load', syncTitle);
      document.body.append(frame);
      frames[name] = frame;
    } else if (target.search || !/^\/(content|site)\/?$/.test(target.pathname))
      post(frame, { type: 'sitetiller-open', href: relative(target) });
    for (const [key, other] of Object.entries(frames)) {
      other.hidden = key !== name;
      post(other, { type: 'sitetiller-visibility', visible: key === name });
    }
    // The address shows where the visible studio actually is (it may be deeper than the requested root).
    let shown = relative(target);
    try {
      const inner = frame.contentWindow.location;
      if (inner.href !== 'about:blank' && /^\/(content|site)\/?$/.test(target.pathname) && !target.search)
        shown = inner.pathname + inner.search + inner.hash;
    } catch {}
    if (push) history.pushState({}, '', shown);
    else history.replaceState({}, '', shown);
    syncTitle();
    frame.focus();
  }
  addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data || {},
      entry = Object.entries(frames).find(([, frame]) => frame.contentWindow === event.source);
    if (!entry) return;
    const frame = entry[1];
    if (data.type === 'sitetiller-navigate' && typeof data.href === 'string') {
      const target = new URL(data.href, location.href);
      if (target.origin === location.origin && /^\/(content|site)(\/|$)/.test(target.pathname)) show(target.href, true);
      else location.assign(target.href);
    } else if (data.type === 'sitetiller-location' && typeof data.href === 'string' && !frame.hidden) {
      const target = new URL(data.href, location.href);
      if (target.origin === location.origin) {
        history.replaceState({}, '', relative(target));
        syncTitle();
      }
    } else if (data.type === 'sitetiller-title' && typeof data.title === 'string' && !frame.hidden)
      document.title = data.title;
  });
  addEventListener('popstate', () => show(location.href, false));
  show(location.href, false);
})();
