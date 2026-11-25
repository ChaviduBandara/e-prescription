// A handwritten prescription's image on the pharmacy screen. It is always in
// one visible state, never blank (CLAUDE.md hard rule 10):
//   loading  "Loading prescription image…"
//   error    "Image failed to load" + Retry
//   ready    the decoded image, tap to open full screen
// The state is on the element as data-image-state, for CSS and tests.
import { el } from '/shared/client.js';

const LOAD_TIMEOUT_MS = 15000; // a hung request must not mean "loading" forever

export function createImageView(rx, { onOpen }) {
  const view = el('div', { className: 'rx-image-view' });
  const label = `Handwritten prescription ${rx.id}`;
  let attempt = 0;
  let state = 'loading';

  function show(next, ...children) {
    state = next;
    view.dataset.imageState = next;
    view.replaceChildren(...children);
  }

  function showLoading() {
    show('loading', el('p', { className: 'rx-image-view__msg', role: 'status' }, 'Loading prescription image…'));
  }

  function showError() {
    const retry = el('button', { type: 'button', className: 'btn btn--primary' }, 'Retry');
    retry.addEventListener('click', () => load());
    show('error', el('p', { className: 'rx-image-view__msg', role: 'alert' }, 'Image failed to load'), retry);
  }

  function showReady(img) {
    const button = el(
      'button',
      { type: 'button', className: 'rx-image', title: 'Tap to view full screen', 'aria-label': `${label}. Open full screen.` },
      img
    );
    button.addEventListener('click', () => onOpen(img.getAttribute('src')));
    show('ready', button);
  }

  // Loads the image off-screen and shows it only once it has decoded. A
  // retry gets a new URL so a cached failure is not reused.
  async function load() {
    attempt += 1;
    const mine = attempt;
    showLoading();
    const img = new Image();
    img.alt = label;
    img.src = mine === 1 ? rx.imageUrl : `${rx.imageUrl}?attempt=${mine}`;
    let timer;
    try {
      await Promise.race([
        img.decode(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS);
        })
      ]);
      if (!img.naturalWidth) throw new Error('empty image');
      if (mine === attempt) showReady(img);
    } catch {
      img.src = ''; // stop a hung request
      if (mine === attempt) showError();
    } finally {
      clearTimeout(timer);
    }
  }

  load();
  return {
    el: view,
    state: () => state,
    retryIfFailed() {
      if (state === 'error') load();
    }
  };
}
