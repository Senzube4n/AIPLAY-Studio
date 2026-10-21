/** Native toolbar disclosures, with one bounded popup open at a time. */
export function mountToolbarMenus(header, {
  window: win = globalThis.window,
  document: doc = header?.ownerDocument ?? globalThis.document,
} = {}) {
  if (!header?.querySelectorAll || !doc?.addEventListener || !win?.addEventListener) return () => {};
  const properties = ['position', 'left', 'right', 'top', 'bottom', 'z-index',
    'max-width', 'max-height', 'min-width', 'box-sizing', 'overflow'];
  const menus = [...header.querySelectorAll('details.d-more')].flatMap(details => {
    const summary = details.querySelector(':scope > summary');
    const body = details.querySelector(':scope > .d-morebody');
    if (!summary || !body) return [];
    return [{ details, summary, body, original: properties.map(name => [name,
      body.style.getPropertyValue(name), body.style.getPropertyPriority(name)]) }];
  });
  const disposers = [];
  let active = null, disposed = false;
  const bind = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    disposers.push(() => target.removeEventListener(name, callback, options));
  };
  function restore(menu) {
    for (const [name, value, priority] of menu.original) {
      if (value) menu.body.style.setProperty(name, value, priority);
      else menu.body.style.removeProperty(name);
    }
  }
  function close(menu) {
    menu.details.open = false;
    restore(menu);
    if (active === menu) active = null;
  }
  const closeAll = () => { for (const menu of menus) close(menu); };
  function position(menu) {
    const viewport = win.visualViewport;
    const width = Number(viewport?.width) || win.innerWidth || doc.documentElement?.clientWidth || 0;
    const height = Number(viewport?.height) || win.innerHeight || doc.documentElement?.clientHeight || 0;
    if (width < 1 || height < 1) return close(menu);
    const x = Number(viewport?.offsetLeft) || 0, y = Number(viewport?.offsetTop) || 0;
    const margin = Math.min(8, width / 4, height / 4), gap = 4;
    const leftEdge = x + margin, rightEdge = x + width - margin;
    const topEdge = y + margin, bottomEdge = y + height - margin;
    const anchor = menu.summary.getBoundingClientRect();
    if (anchor.right < x || anchor.left > x + width || anchor.bottom < y || anchor.top > y + height)
      return close(menu);
    const style = menu.body.style;
    for (const [name, value] of Object.entries({ position: 'fixed', right: 'auto', bottom: 'auto',
      left: '0px', top: '0px', 'z-index': '100', 'box-sizing': 'border-box',
      'min-width': '0px', 'max-width': `${rightEdge - leftEdge}px`,
      'max-height': `${bottomEdge - topEdge}px`, overflow: 'auto' })) style.setProperty(name, value);
    const wanted = menu.body.getBoundingClientRect();
    const below = Math.max(0, bottomEdge - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - gap - topEdge);
    const upwards = wanted.height > below && above > below;
    const available = upwards ? above : below;
    if (available < 1) return close(menu);
    style.setProperty('max-height', `${available}px`);
    const box = menu.body.getBoundingClientRect();
    const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - box.width));
    const top = Math.max(topEdge, Math.min(upwards ? anchor.top - gap - box.height : anchor.bottom + gap,
      bottomEdge - box.height));
    style.setProperty('left', `${left}px`);
    style.setProperty('top', `${top}px`);
  }
  function opened(menu) {
    if (disposed) return;
    if (!menu.details.open) { restore(menu); if (active === menu) active = null; return; }
    for (const other of menus) if (other !== menu) close(other);
    active = menu;
    position(menu);
  }
  for (const menu of menus) bind(menu.details, 'toggle', () => opened(menu));
  bind(doc, 'pointerdown', event => {
    if (active && !active.details.contains(event.target)) closeAll();
  }, true);
  bind(doc, 'keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !active) return;
    const summary = active.summary;
    closeAll();
    event.preventDefault();
    event.stopPropagation();
    summary.focus();
  });
  bind(header, 'click', event => {
    const button = event.target?.closest?.('button');
    if (active && button && !button.disabled && active.body.contains(button)) closeAll();
    // Summary clicks and input/select gestures keep their native behavior.
  });
  bind(win, 'resize', closeAll);
  bind(win, 'scroll', closeAll);
  bind(doc, 'scroll', event => {
    // A constrained popup must be scrollable without dismissing itself.
    if (active && active.body.contains(event.target)) return;
    closeAll();
  }, true);
  if (win.visualViewport?.addEventListener) {
    bind(win.visualViewport, 'resize', closeAll);
    bind(win.visualViewport, 'scroll', closeAll);
  }
  const firstOpen = menus.find(menu => menu.details.open);
  if (firstOpen) opened(firstOpen);
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) dispose();
    closeAll();
  };
}
