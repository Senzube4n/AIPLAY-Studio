// The workshop shares the real Studio shell. Only its WebGL document is isolated.
const avatarId = /^av_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function workshopRoute(href) {
  const url = new URL(href);
  const id = url.searchParams.get('avatar') || url.searchParams.get('id');
  return {id: avatarId.test(id || '') ? id : null,
    overlay: url.searchParams.get('overlay') === '1',
    embedded: url.searchParams.get('embedded') === '1'};
}
export function workshopFrameUrl(href) {
  const {id} = workshopRoute(href);
  return `/avatars.html?embedded=1${id ? `&id=${id}` : ''}`;
}
export function workshopStudioUrl(href) {
  const {id} = workshopRoute(href);
  return `/?view=avatars${id ? `&avatar=${id}` : ''}`;
}
export function initialStudioView(href, allowed) {
  const view = new URL(href).searchParams.get('view');
  return allowed.includes(view) ? view : null;
}
let initialized = false, active = false;
export function showAvatarWorkshop(visible) {
  const frame = document.getElementById('avatarFrame');
  if (!frame) return;
  active = visible;
  const announce = () => frame.contentWindow?.postMessage({type:'aiplay-avatar-visibility', active}, location.origin);
  if (!initialized) {
    initialized = true;
    frame.addEventListener('load', announce);
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data?.type === 'aiplay-avatar-height' && Number.isFinite(data.height)) {
        frame.style.height = `${Math.min(20000, Math.max(400, Math.ceil(data.height)))}px`;
      }
      if (data?.type === 'aiplay-avatar-selection' && active && avatarId.test(data.id || '')) {
        const url = new URL(location.href);
        url.searchParams.set('view', 'avatars'); url.searchParams.set('avatar', data.id);
        history.replaceState(null, '', url);
      }
    });
  }
  if (visible && !frame.getAttribute('src')) frame.src = workshopFrameUrl(location.href);
  else announce();
}
