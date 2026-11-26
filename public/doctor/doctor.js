// Doctor screen: start a session, send typed or handwritten prescriptions,
// see their status.
import { el, formatTime, sessionLabel, connectSocket, PrescriptionStore } from '/shared/client.js';
import { createPad } from '/doctor/pad.js';

const ACK_TIMEOUT_MS = 15000; // a handwriting PNG can take a moment on slow WiFi
const RETRY_MS = 3000; // after a timeout while still connected
// Must match src/validation.js and src/png.js.
const PATIENT_ERROR = 'Patient ID or token number is required.';
const NO_DRAWING_ERROR = 'Draw the prescription before sending.';
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const store = new PrescriptionStore();
let session = null;

// Loaded by /shared/auth.js only after the doctor PIN is accepted.
const socket = connectSocket({
  role: 'doctor',
  statusEl: $('conn'),
  bannerEl: $('offline-banner'),
  onState: (state) => {
    $('load-error').hidden = true;
    setSession(state.session);
    store.sync(state.session && state.session.id, state.prescriptions);
    renderList();
  },
  onLoadError: () => showLoadError()
});

socket.on('session:started', (s) => {
  setSession(s);
  store.sync(s.id);
  renderList();
});

socket.on('prescription:new', (rx) => {
  if (!session || rx.sessionId !== session.id) return void socket.reload();
  store.upsert(rx);
  renderList();
});

socket.on('prescription:dispensed', (rx) => {
  if (!store.has(rx.id)) return;
  store.upsert(rx);
  renderList();
});

// The pharmacist ended the session: back to the start screen.
socket.on('session:ended', (s) => {
  if (!session || s.id !== session.id) return;
  setSession(null);
  store.sync(null);
  renderList();
  resetForm();
  setStatus('');
  $('ended-note').textContent = `The pharmacy ended session ${s.id} at ${formatTime(s.endedAt)}.`;
  $('ended-note').hidden = false;
});

// ---- Session -------------------------------------------------------------

function setSession(s) {
  session = s;
  $('loading').hidden = true;
  $('no-session').hidden = Boolean(s);
  $('session').hidden = !s;
  $('session-label').textContent = sessionLabel(s);
  if (s) $('ended-note').hidden = true;
}

function showLoadError() {
  $('loading').hidden = true;
  const box = $('load-error');
  box.textContent = 'Could not load the session from the pharmacy PC. Retrying when the connection is back.';
  box.hidden = false;
}

$('start-session').addEventListener('click', () => {
  const button = $('start-session');
  const error = $('start-error');
  error.textContent = '';
  if (!socket.connected) {
    error.textContent = 'Offline. Check the WiFi and try again.';
    return;
  }
  button.disabled = true;
  socket.timeout(ACK_TIMEOUT_MS).emit('session:start', {}, (err, res) => {
    button.disabled = false;
    if (err) return (error.textContent = 'No reply from the pharmacy PC. Try again.');
    if (!res.ok) return (error.textContent = res.error);
    setSession(res.session);
    store.sync(res.session.id);
    renderList();
    resetForm();
  });
});

// ---- Form ------------------------------------------------------------------

function addLine() {
  const n = $('lines').children.length + 1;
  const input = (name, label) =>
    el('input', { className: 'input', name, 'aria-label': `${label}, line ${n}`, maxLength: name === 'instructions' ? 500 : 200 });
  const row = el(
    'div',
    { className: 'line' },
    input('medicine', 'Medicine'),
    input('dosage', 'Dosage'),
    input('instructions', 'Instructions'),
    el('button', { type: 'button', className: 'remove-line', 'aria-label': `Remove line ${n}`, title: 'Remove line' }, '×')
  );
  row.querySelector('.remove-line').addEventListener('click', () => {
    row.remove();
    if ($('lines').children.length === 0) addLine();
  });
  $('lines').append(row);
  return row;
}

// ---- Typed / Handwrite ------------------------------------------------------

const pad = createPad($('pad'), {
  wrapper: document.querySelector('.pad'),
  undoButton: $('pad-undo'),
  clearButton: $('pad-clear'),
  lockedEl: $('pad-locked')
});

function mode() {
  return document.querySelector('input[name=mode]:checked').value;
}

// Switching keeps what was typed or drawn in the other mode.
for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    const handwritten = mode() === 'handwritten';
    $('typed-fields').hidden = handwritten;
    $('handwrite-fields').hidden = !handwritten;
    if (handwritten) pad.fit(); // the canvas has no size while hidden
    setStatus('');
  });
}

// The payload for prescription:new. Handwriting goes as the PNG bytes,
// exactly as drawn; nothing reads or converts it.
async function readForm() {
  const patientRef = $('patient-ref').value;
  if (mode() === 'handwritten') {
    return { kind: 'handwritten', patientRef, image: pad.isEmpty() ? null : await pad.toPng() };
  }
  const lines = [...$('lines').children].map((row) => ({
    medicine: row.querySelector('[name=medicine]').value,
    dosage: row.querySelector('[name=dosage]').value,
    instructions: row.querySelector('[name=instructions]').value
  }));
  return { kind: 'typed', patientRef, lines };
}

// Catches the common mistakes before sending. The server checks again.
function checkForm(payload) {
  if (!payload.patientRef.trim()) return PATIENT_ERROR;
  if (payload.kind !== 'handwritten') return null;
  // Rotated: the doctor cannot see the drawing to check it, so wait.
  if (pad.lockMessage()) return pad.lockMessage();
  if (!payload.image) return NO_DRAWING_ERROR;
  if (payload.image.byteLength > MAX_IMAGE_BYTES) return 'The drawing is too large. Clear it and draw again.';
  return null;
}

function showFormError(message) {
  setStatus(message, 'error');
  if (message === PATIENT_ERROR) {
    $('patient-ref').setAttribute('aria-invalid', 'true');
    $('patient-ref').focus();
  } else if (message === NO_DRAWING_ERROR) {
    pad.markInvalid(true);
  }
}

function resetForm() {
  $('patient-ref').value = '';
  $('patient-ref').removeAttribute('aria-invalid');
  $('lines').replaceChildren();
  addLine();
  pad.clear();
}

function setStatus(text, kind) {
  const status = $('send-status');
  status.textContent = text;
  status.className = `msg${kind ? ` msg--${kind}` : ''}`;
}

$('add-line').addEventListener('click', () => addLine().querySelector('input').focus());

// ---- Sending ---------------------------------------------------------------
// One tap on Send gets one random request ID. Until the server confirms,
// the form is locked and the same payload and ID are sent again after a
// timeout or a reconnect. The server recognises the ID and replies with
// the prescription it already saved, so a retry never makes a second one.

const WAITING_OFFLINE =
  'NOT sent yet: no connection to the pharmacy PC. It will send by itself when the connection is back. Keep this page open.';
const WAITING_NO_REPLY = 'No reply from the pharmacy PC yet. Trying again by itself; it will not be sent twice.';

let pending = null; // { payload, attempts, timer }: a send not yet confirmed

// crypto.randomUUID() needs https; the tablet uses plain http on the LAN.
function newRequestId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// While a send waits, the doctor cannot change what is being sent.
function lockForm(locked) {
  for (const id of ['patient-ref', 'typed-fields', 'handwrite-fields']) $(id).inert = locked;
  document.querySelector('.mode').inert = locked;
  $('rx-form').classList.toggle('rx-form--waiting', locked);
  $('send').disabled = locked;
  $('send').textContent = locked ? 'Sending…' : 'Send';
}

$('rx-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const send = $('send');
  if (send.disabled || pending) return; // a send is already in flight
  $('patient-ref').removeAttribute('aria-invalid');
  pad.markInvalid(false);

  send.disabled = true;
  const payload = await readForm();
  const problem = checkForm(payload);
  if (problem) {
    send.disabled = false;
    return showFormError(problem);
  }
  pending = { payload: { ...payload, requestId: newRequestId() }, attempts: 0, timer: null };
  lockForm(true);
  trySend();
});

function trySend() {
  if (!pending) return;
  clearTimeout(pending.timer);
  if (!socket.connected) return setStatus(WAITING_OFFLINE, 'waiting'); // 'connect' calls trySend
  const current = pending;
  const attempt = ++current.attempts;
  if (attempt === 1) setStatus('Sending…');
  socket.timeout(ACK_TIMEOUT_MS).emit('prescription:new', current.payload, (err, res) => {
    // A newer attempt (after a reconnect) has taken over from this one.
    if (pending !== current || current.attempts !== attempt) return;
    if (err) {
      setStatus(socket.connected ? WAITING_NO_REPLY : WAITING_OFFLINE, 'waiting');
      if (socket.connected) current.timer = setTimeout(trySend, RETRY_MS);
      return;
    }
    pending = null;
    lockForm(false);
    if (!res.ok) return showFormError(res.error);
    store.upsert(res.prescription);
    renderList();
    setStatus(`Sent ${res.prescription.id} (${res.prescription.patientRef})`, 'success');
    resetForm();
  });
}

// Back online: send the waiting prescription again straight away, without
// waiting for the old attempt to time out.
socket.on('connect', trySend);
socket.on('disconnect', () => pending && setStatus(WAITING_OFFLINE, 'waiting'));

// ---- List ------------------------------------------------------------------

const STATUS_TEXT = { sent: 'Sent', dispensed: 'Dispensed' };

function renderList() {
  const items = store.list().reverse(); // newest first on the tablet
  $('sent-empty').hidden = items.length > 0;
  $('sent-list').replaceChildren(
    ...items.map((rx) =>
      el(
        'li',
        { className: 'sent-item', dataset: { rxId: rx.id } },
        el('span', { className: 'rx-id' }, rx.id),
        el('span', {}, el('span', { className: 'patient' }, rx.patientRef), ' · ', el('span', { className: 'muted' }, formatTime(rx.createdAt))),
        el('span', { className: `badge badge--${rx.status}` }, STATUS_TEXT[rx.status] || rx.status),
        el('span', { className: 'summary' }, rx.kind === 'handwritten' ? 'Handwritten' : rx.lines.map((l) => l.medicine).join(', '))
      )
    )
  );
}

resetForm();
