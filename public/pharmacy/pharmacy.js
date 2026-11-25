// Pharmacy screen: live queue of prescriptions in arrival order. Each one is
// announced with a notice and a sound, marked Dispensed with a tap, and the
// pharmacist ends the session when the day is done.
import { el, formatTime, sessionLabel, connectSocket, PrescriptionStore } from '/shared/client.js';
import { createImageView, retryFailed, forgetAll } from '/pharmacy/image-view.js';
import { setUpStartGate, announce, dismissNotice } from '/pharmacy/alerts.js';
import { setUpEndSession, closeEndDialog } from '/pharmacy/end-session.js';

const HIGHLIGHT_MS = 15000;
const ACK_TIMEOUT_MS = 10000;

const $ = (id) => document.getElementById(id);
const store = new PrescriptionStore();
let session = null;
let receiving = false; // true after the Start receiving tap
const dispensing = new Set(); // IDs waiting for the server's ack
const cardErrors = new Map(); // ID -> message shown on the card

// Loaded by /shared/auth.js only after the pharmacy PIN is accepted.
const socket = connectSocket({
  role: 'pharmacy',
  statusEl: $('conn'),
  bannerEl: $('offline-banner'),
  onState: (state) => {
    $('load-error').hidden = true;
    if (!state.session || state.session.id !== store.sessionId) clearSession();
    setSession(state.session);
    store.sync(state.session && state.session.id, state.prescriptions);
    renderQueue();
  },
  onLoadError: () => {
    $('loading').hidden = true;
    $('load-error').textContent = 'Could not load the queue. Retrying when the connection is back.';
    $('load-error').hidden = false;
  }
});

// Images that failed while the server was unreachable load again on reconnect.
socket.on('connect', retryFailed);

// ---- Archive warning ---------------------------------------------------------

socket.on('archive:status', showArchiveStatus);
socket.on('connect', async () => {
  try {
    const res = await fetch('/api/archive/status', { cache: 'no-store' });
    if (res.ok) showArchiveStatus(await res.json());
  } catch {
    // Offline again: the next connect tries again.
  }
});

function showArchiveStatus({ failing }) {
  const box = $('archive-warning');
  box.hidden = failing.length === 0;
  if (!failing.length) return;
  const ids = failing.map((f) => f.sessionId).join(', ');
  const what = failing.length === 1 ? `The PDF archive for session ${ids}` : `The PDF archives for sessions ${ids}`;
  const next = failing.map((f) => f.nextRetryAt).sort()[0];
  box.textContent =
    `${what} could not be saved: ${failing[0].error}. ` +
    `Retrying automatically${next ? ` (next try ${formatTime(next)})` : ''}. ` +
    'The prescriptions are safe in the database.';
}

setUpStartGate(() => {
  receiving = true;
  $('receiving').hidden = false;
  setSession(session);
});

socket.on('session:started', (s) => {
  clearSession();
  setSession(s);
  store.sync(s.id);
  renderQueue();
});

socket.on('prescription:new', async (rx) => {
  if (!session || rx.sessionId !== session.id) {
    // Arrived before this screen knew the session: load it, then alert.
    const known = store.has(rx.id);
    await socket.reload();
    if (!known && store.has(rx.id)) notify(rx);
    return;
  }
  if (!store.upsert(rx)) return; // already shown
  renderQueue();
  notify(rx);
});

socket.on('prescription:dispensed', (rx) => {
  if (!store.has(rx.id)) return;
  store.upsert(rx);
  renderQueue();
});

socket.on('session:ended', (s) => endedSession(s));

function setSession(s) {
  session = s;
  $('loading').hidden = true;
  $('no-session').hidden = Boolean(s);
  $('queue-section').hidden = !s;
  $('end-session').hidden = !s || !receiving;
  $('session-label').textContent = sessionLabel(s);
  if (s) $('ended-note').hidden = true;
}

// Forgets everything shown for the previous session.
function clearSession() {
  imageViews.clear();
  forgetAll();
  dispensing.clear();
  cardErrors.clear();
}

// Back to the start state: waiting for the doctor's next session.
function endedSession(s) {
  if (!session || s.id !== session.id) return;
  clearSession();
  dismissNotice();
  closeEndDialog();
  if ($('viewer').open) $('viewer').close();
  setSession(null);
  store.sync(null);
  renderQueue();
  const archived = s.archiveFile ? ` Archived as ${s.archiveFile}.` : ' The PDF archive is not saved yet (see the warning above).';
  $('ended-note').textContent = `Session ${s.id} ended at ${formatTime(s.endedAt)}.${archived}`;
  $('ended-note').hidden = false;
}

setUpEndSession({
  socket,
  getState: () => {
    const items = store.list();
    return { session, total: items.length, waiting: items.filter((rx) => rx.status !== 'dispensed').length };
  },
  onEnded: endedSession
});

// ---- Alerts ----------------------------------------------------------------

function notify(rx) {
  if (!receiving) return; // shown in the queue once Start receiving is tapped
  announce(rx);
  const card = document.querySelector(`[data-rx-id="${rx.id}"]`);
  if (card) {
    card.classList.add('rx-card--new');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => card.classList.remove('rx-card--new'), HIGHLIGHT_MS);
  }
}

// ---- Dispensed -------------------------------------------------------------

function dispense(rx) {
  if (dispensing.has(rx.id)) return;
  cardErrors.delete(rx.id);
  if (!socket.connected) {
    cardErrors.set(rx.id, 'Offline: NOT marked dispensed. Try again when connected.');
    return renderQueue();
  }
  dispensing.add(rx.id);
  renderQueue();
  socket.timeout(ACK_TIMEOUT_MS).emit('prescription:dispensed', { id: rx.id }, (err, res) => {
    dispensing.delete(rx.id);
    if (err) cardErrors.set(rx.id, 'No reply from the server. Check the card, then try again.');
    else if (!res.ok) cardErrors.set(rx.id, res.error);
    else store.upsert(res.prescription);
    renderQueue();
  });
}

// ---- Queue -----------------------------------------------------------------

const STATUS_TEXT = { sent: 'Waiting', dispensed: 'Dispensed' };

function renderQueue() {
  const items = store.list();
  const waiting = items.filter((rx) => rx.status !== 'dispensed');
  // Most recently dispensed first.
  const done = items
    .filter((rx) => rx.status === 'dispensed')
    .sort((a, b) => (b.dispensedAt || '').localeCompare(a.dispensedAt || ''));

  $('queue-empty').hidden = waiting.length > 0;
  $('queue-count').textContent = waiting.length ? `(${waiting.length})` : '';
  $('dispensed-section').hidden = done.length === 0;
  $('dispensed-count').textContent = `(${done.length})`;

  const highlighted = new Set(
    [...document.querySelectorAll('.rx-card--new')].map((node) => node.dataset.rxId)
  );
  $('queue').replaceChildren(...waiting.map((rx) => renderCard(rx, highlighted.has(rx.id))));
  $('dispensed-list').replaceChildren(...done.map((rx) => renderCard(rx, false)));
}

function renderCard(rx, highlighted) {
  const isDone = rx.status === 'dispensed';
  const classes = ['card', 'rx-card', highlighted && 'rx-card--new', isDone && 'rx-card--done'];
  return el(
    'li',
    { className: classes.filter(Boolean).join(' '), dataset: { rxId: rx.id } },
    el(
      'div',
      { className: 'rx-card__head' },
      el('span', { className: 'rx-id' }, rx.id),
      el('span', { className: 'time' }, formatTime(rx.createdAt)),
      el('span', { className: `badge badge--${rx.status}` }, STATUS_TEXT[rx.status] || rx.status)
    ),
    el('p', { className: 'rx-card__patient' }, rx.patientRef),
    rx.kind === 'handwritten' ? renderHandwriting(rx) : renderLines(rx.lines),
    renderActions(rx)
  );
}

function renderActions(rx) {
  if (rx.status === 'dispensed') {
    return el('p', { className: 'rx-card__done muted' }, `Dispensed at ${formatTime(rx.dispensedAt)}`);
  }
  const busy = dispensing.has(rx.id);
  const button = el(
    'button',
    { type: 'button', className: 'btn btn--success', disabled: busy },
    busy ? 'Saving…' : 'Dispensed'
  );
  button.addEventListener('click', () => dispense(rx));
  return el(
    'div',
    { className: 'rx-card__actions' },
    button,
    el('p', { className: 'msg msg--error', role: 'alert' }, cardErrors.get(rx.id) || '')
  );
}

// Handwriting is shown as the image, exactly as drawn, and only once it has
// decoded (see image-view.js). Views are kept across re-renders so the image
// is not reloaded each time a prescription arrives or is dispensed.
const imageViews = new Map();

function renderHandwriting(rx) {
  if (!imageViews.has(rx.id)) {
    const view = createImageView({
      src: rx.imageUrl,
      alt: `Handwritten prescription ${rx.id}`,
      onOpen: (img) => openViewer(rx, img)
    });
    imageViews.set(rx.id, view);
  }
  return imageViews.get(rx.id).element;
}

function renderLines(lines) {
  return el(
    'table',
    { className: 'rx-lines' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Medicine'), el('th', {}, 'Dosage'), el('th', {}, 'Instructions'))),
    el(
      'tbody',
      {},
      ...lines.map((l) => el('tr', {}, el('td', {}, l.medicine), el('td', {}, l.dosage), el('td', {}, l.instructions)))
    )
  );
}

// ---- Full-screen viewer ----------------------------------------------------

const viewer = $('viewer');

// Opened only from a card whose image has decoded, so it reuses that image's
// URL (already in memory) and is never blank.
function openViewer(rx, img) {
  $('viewer-title').textContent = `${rx.id} · ${rx.patientRef}`;
  $('viewer-image').src = img.getAttribute('src');
  $('viewer-image').alt = `Handwritten prescription ${rx.id}`;
  viewer.showModal();
}

$('viewer-close').addEventListener('click', () => viewer.close());
// A tap anywhere on the picture closes it too.
$('viewer-image').addEventListener('click', () => viewer.close());
