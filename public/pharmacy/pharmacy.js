// Pharmacy screen: live queue of prescriptions in arrival order, with an
// on-screen notice and an alert sound for each new one.
import { el, formatTime, sessionLabel, connectSocket, PrescriptionStore } from '/shared/client.js';

const NOTICE_MS = 8000;
const HIGHLIGHT_MS = 15000;

const $ = (id) => document.getElementById(id);
const store = new PrescriptionStore();
const alertSound = new Audio('/shared/alert.wav');
let session = null;
let noticeTimer = null;

const socket = connectSocket({
  statusEl: $('conn'),
  onState: (state) => {
    $('load-error').hidden = true;
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

socket.on('session:started', (s) => {
  setSession(s);
  store.sync(s.id);
  renderQueue();
});

socket.on('prescription:new', async (rx) => {
  if (!session || rx.sessionId !== session.id) {
    // Arrived before this screen knew the session: load it, then alert.
    const known = store.has(rx.id);
    await socket.reload();
    if (!known && store.has(rx.id)) announce(rx);
    return;
  }
  if (!store.upsert(rx)) return; // already shown
  renderQueue();
  announce(rx);
});

function setSession(s) {
  session = s;
  $('loading').hidden = true;
  $('no-session').hidden = Boolean(s);
  $('queue-section').hidden = !s;
  $('session-label').textContent = sessionLabel(s);
}

// ---- Alerts ----------------------------------------------------------------

function announce(rx) {
  const notice = $('notice');
  notice.textContent = `New prescription ${rx.id} for ${rx.patientRef}`;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), NOTICE_MS);

  const card = document.querySelector(`[data-rx-id="${rx.id}"]`);
  if (card) {
    card.classList.add('rx-card--new');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => card.classList.remove('rx-card--new'), HIGHLIGHT_MS);
  }
  playSound();
}

function playSound() {
  alertSound.currentTime = 0;
  const result = alertSound.play();
  // Browsers block sound until the page has been clicked once.
  if (result && result.catch) result.catch(() => ($('sound-hint').hidden = false));
}

// Any click on the page counts as the user gesture that unlocks sound.
document.addEventListener('pointerdown', () => ($('sound-hint').hidden = true));
$('sound-hint').addEventListener('click', () => {
  alertSound.muted = true;
  alertSound.play().then(() => {
    alertSound.pause();
    alertSound.muted = false;
  }, () => {});
});

// ---- Queue -----------------------------------------------------------------

const STATUS_TEXT = { sent: 'Waiting', dispensed: 'Dispensed' };

function renderQueue() {
  const items = store.list();
  $('queue-empty').hidden = items.length > 0;
  $('queue-count').textContent = items.length ? `(${items.length})` : '';
  const highlighted = new Set(
    [...document.querySelectorAll('.rx-card--new')].map((node) => node.dataset.rxId)
  );
  $('queue').replaceChildren(...items.map((rx) => renderCard(rx, highlighted.has(rx.id))));
}

function renderCard(rx, highlighted) {
  return el(
    'li',
    { className: `card rx-card${highlighted ? ' rx-card--new' : ''}`, dataset: { rxId: rx.id } },
    el(
      'div',
      { className: 'rx-card__head' },
      el('span', { className: 'rx-id' }, rx.id),
      el('span', { className: 'time' }, formatTime(rx.createdAt)),
      el('span', { className: `badge badge--${rx.status}` }, STATUS_TEXT[rx.status] || rx.status)
    ),
    el('p', { className: 'rx-card__patient' }, rx.patientRef),
    renderLines(rx.lines)
  );
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
