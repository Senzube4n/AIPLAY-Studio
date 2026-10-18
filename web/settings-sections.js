/* Settings keeps its controls mounted, but opens only the chosen topic. */
const mounted = new WeakMap();
const selector = '.pnav[data-sections="single"]';

function linkedCard(nav, cards) {
  let id;
  try { id = decodeURIComponent(nav.ownerDocument.defaultView.location.hash.slice(1)); }
  catch { return null; }
  const card = nav.ownerDocument.getElementById(id)?.closest('.pcard[data-nav]');
  return cards.includes(card) ? card : null;
}

function select(nav, state, card) {
  state.selected = card.id;
  for (const section of state.cards) {
    section.classList.toggle('section-inactive', section !== card);
  }
  for (const link of nav.children) {
    const active = link.dataset.target === card.id;
    link.classList.toggle('on', active);
    link.setAttribute('aria-selected', String(active));
    link.tabIndex = active ? 0 : -1;
  }
  // A newly opened section may contain hints that were never measured.
  nav.dispatchEvent(new nav.ownerDocument.defaultView.Event('aiplay:section-open', { bubbles: true }));
}

function remember(nav, card, push = false) {
  const win = nav.ownerDocument.defaultView;
  const url = new URL(win.location.href);
  url.hash = card.id;
  if (url.href !== win.location.href) win.history[push ? 'pushState' : 'replaceState'](null, '', url);
}

export function mountSettingsSections(nav) {
  const page = nav.closest('.page');
  const cards = [...page.querySelectorAll('.pcard[data-nav]')].filter(card => card.id && !card.hidden);
  const sig = cards.map(card => card.id).join('|');
  let state = mounted.get(nav);
  if (!state) {
    state = { cards: [], sig: null, selected: null };
    mounted.set(nav, state);
    nav.setAttribute('role', 'tablist');
    nav.addEventListener('keydown', event => {
      const links = [...nav.children];
      const index = links.indexOf(event.target);
      if (index >= 0 && event.key === ' ') {
        event.preventDefault();
        links[index].click();
        return;
      }
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length;
      links[next].click();
      links[next].focus({ preventScroll: true });
      links[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    const followHash = () => {
      const card = linkedCard(nav, state.cards)
        || (!nav.ownerDocument.defaultView.location.hash ? state.cards[0] : null);
      if (card) {
        select(nav, state, card);
        const win = nav.ownerDocument.defaultView;
        if (page.hidden && new URL(win.location.href).searchParams.get('view') === 'settings') {
          nav.ownerDocument.querySelector('.rail [data-view="settings"]')?.click();
        }
        if (!page.hidden) nav.scrollIntoView({ block: 'start' });
      }
    };
    nav.ownerDocument.defaultView.addEventListener('hashchange', followHash);
    nav.ownerDocument.defaultView.addEventListener('popstate', followHash);
  }
  if (state.sig === sig) return;
  state.sig = sig;
  state.cards = cards;
  nav.replaceChildren(...cards.map(card => {
    const link = nav.ownerDocument.createElement('a');
    link.href = `#${card.id}`;
    link.id = `${card.id}-tab`;
    link.textContent = card.dataset.nav;
    link.dataset.target = card.id;
    link.setAttribute('role', 'tab');
    link.setAttribute('aria-controls', card.id);
    card.setAttribute('role', 'tabpanel');
    card.setAttribute('aria-labelledby', link.id);
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      select(nav, state, card);
      remember(nav, card, true);
      nav.scrollIntoView({ block: 'start' });
    });
    return link;
  }));
  const current = linkedCard(nav, cards) || cards.find(card => card.id === state.selected) || cards[0];
  if (current) select(nav, state, current);
}

/** Reveal a control's Settings topic before a shortcut scrolls or focuses it. */
export function revealSetting(target) {
  const nav = target?.closest?.('#settings')?.querySelector(selector);
  if (!nav) return;
  mountSettingsSections(nav);
  const state = mounted.get(nav);
  const card = target.closest('.pcard[data-nav]');
  if (!state.cards.includes(card)) return;
  select(nav, state, card);
  remember(nav, card);
}
