// A handwritten prescription on the pharmacy screen. It is never shown as a
// blank image: until the PNG has fully decoded the card says it is loading,
// and if it fails the card says so and offers Retry.
import { el } from '/shared/client.js';

const LOADING_TEXT = 'Loading prescription image…';
const ERROR_TEXT = 'Image failed to load';

// Every view that is currently in the error state, for retryFailed().
const failed = new Set();

// Returns { element, retry }. `onOpen(img)` runs when the ready image is tapped.
export function createImageView({ src, alt, onOpen }) {
  const message = el('p', { className: 'rx-image-state__text' }, LOADING_TEXT);
  const retryButton = el('button', { type: 'button', className: 'btn btn--secondary', hidden: true }, 'Retry');
  const placeholder = el(
    'div',
    { className: 'rx-image-state', role: 'status' },
    message,
    retryButton
  );
  const element = el('div', { className: 'rx-image-view', dataset: { state: 'loading' } }, placeholder);
  let attempt = 0;

  const view = { element, retry: load };

  function show(state) {
    element.dataset.state = state;
    message.textContent = state === 'error' ? ERROR_TEXT : LOADING_TEXT;
    retryButton.hidden = state !== 'error';
    if (state === 'error') failed.add(view);
    else failed.delete(view);
  }

  async function load() {
    attempt += 1;
    const mine = attempt;
    show('loading');
    const img = el('img', { alt, decoding: 'async' });
    // A fresh URL on retries, so no browser cache can hand back the failure.
    img.src = mine === 1 ? src : `${src}?attempt=${mine}`;
    try {
      await img.decode();
      if (!img.naturalWidth) throw new Error('Image decoded with no pixels');
    } catch {
      if (mine === attempt) show('error');
      return;
    }
    if (mine !== attempt) return; // a newer attempt took over
    const button = el(
      'button',
      { type: 'button', className: 'rx-image', title: 'Tap to view full screen', 'aria-label': `${alt}. Open full screen.` },
      img
    );
    button.addEventListener('click', () => onOpen(img));
    show('ready');
    element.replaceChildren(button);
  }

  retryButton.addEventListener('click', load);
  load();
  return view;
}

// Tries every failed image again, e.g. when the connection comes back.
export function retryFailed() {
  for (const view of [...failed]) view.retry();
}

// Stops tracking views that are no longer on screen (e.g. a new session).
export function forgetAll() {
  failed.clear();
}
