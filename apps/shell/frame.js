// Shell frame: each studio and Settings are loaded into their own iframe and stay alive while the user switches,
// so unsent requests, open forms and selections survive. The frames talk to the frame page with postMessage:
//  sitetiller-navigate {href}  switch studio or Settings, or leave the frame (home, logout)
//  sitetiller-location {href}  the visible frame changed its own address
//  sitetiller-title {title}    the visible frame changed its title
//  sitetiller-mode {mode}      AI Studio's sun/moon chose light or dark for the whole editor
// The frame tells each studio whether it is visible (sitetiller-visibility) and asks an already loaded
// studio to open a specific screen (sitetiller-open), e.g. AI settings or the structure editor. Settings open
// fresh every time; when something was saved there meanwhile, the studios load again (documentation 2.2).
(() => {
  const frames = {};
  const paneOf = (path) =>
    /^\/(settings|password)(\/|$)/.test(path) ? 'settings' : path.startsWith('/site') ? 'site' : 'content';
  const titles = { site: 'AI Studio', content: 'Editor obsahu', settings: 'Nastavení' };
  const relative = (url) => url.pathname + url.search + url.hash;
  const post = (frame, message) => {
    try {
      frame.contentWindow.postMessage(message, location.origin);
    } catch {}
  };
  const saves = () =>
    fetch('/__shell/settings-saves', { cache: 'no-store' })
      .then((r) => r.json())
      .then((r) => r.saves)
      .catch(() => null);
  let savesAtOpen = null;
  // The sun/moon of AI Studio switches the colour mode of every part for a while (documentation 2.4): the frame keeps
  // it while it lives and tells each part, also one that loads later. A new opening follows the settings again.
  let mode = null;
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
      name = paneOf(target.pathname),
      leaving = Object.entries(frames).find(([, frame]) => !frame.hidden)?.[0];
    let frame = frames[name];
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = titles[name];
      frame.src = relative(target);
      frame.addEventListener('load', () => {
        syncTitle();
        if (mode) post(frame, { type: 'sitetiller-mode', mode });
      });
      document.body.append(frame);
      frames[name] = frame;
    } else if (name === 'settings') frame.src = relative(target);
    else if (target.search || !/^\/(content|site)\/?$/.test(target.pathname))
      post(frame, { type: 'sitetiller-open', href: relative(target) });
    for (const [key, other] of Object.entries(frames)) {
      other.hidden = key !== name;
      if (key !== 'settings') post(other, { type: 'sitetiller-visibility', visible: key === name });
    }
    if (name === 'settings' && leaving !== 'settings') saves().then((count) => (savesAtOpen = count));
    // Back from Settings: the studios load again only when something was saved there.
    if (leaving === 'settings' && name !== 'settings') {
      const before = savesAtOpen;
      saves().then((count) => {
        if (before === null || count === before) return;
        // A saved colour mode replaces the sun/moon choice.
        mode = null;
        for (const [key, studio] of Object.entries(frames))
          if (key !== 'settings')
            try {
              studio.contentWindow.location.reload();
            } catch {}
      });
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
    if (data.type === 'sitetiller-mode' && ['light', 'dark'].includes(data.mode)) {
      mode = data.mode;
      for (const other of Object.values(frames)) if (other !== frame) post(other, { type: 'sitetiller-mode', mode });
    } else if (data.type === 'sitetiller-navigate' && typeof data.href === 'string') {
      const target = new URL(data.href, location.href);
      if (target.origin === location.origin && /^\/(content|site|settings|password)(\/|$)/.test(target.pathname))
        show(target.href, true);
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
