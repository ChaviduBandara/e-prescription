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

// The pharmacist ended the session: back to the start screen. A send still
// waiting, or one refused because its session ended, keeps the form as it
// is, so the doctor can send it again in the next session.
socket.on('session:ended', (s) => {
  if (!session || s.id !== session.id) return;
  setSession(null);
  store.sync(null);
  renderList();
  if (!pending && !unsent) {
    resetForm();
    setStatus('');
  }
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
  if (s && mode() === 'handwritten') pad.fit(); // e.g. a drawing put back after a reload
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
    if (!unsent) resetForm(); // a refused send stays filled in, to send again
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
function showMode() {
  const handwritten = mode() === 'handwritten';
  $('typed-fields').hidden = handwritten;
  $('handwrite-fields').hidden = !handwritten;
  if (handwritten) pad.fit(); // the canvas has no size while hidden
}
for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    showMode();
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

// Puts a saved send back into the form (see restoreWaitingSend).
function fillForm(payload, padSnapshot) {
  document.querySelector(`input[name=mode][value=${payload.kind}]`).checked = true;
  $('patient-ref').value = payload.patientRef;
  if (payload.kind === 'handwritten') {
    pad.load(padSnapshot);
  } else {
    $('lines').replaceChildren();
    for (const line of payload.lines) {
      const row = addLine();
      for (const name of ['medicine', 'dosage', 'instructions']) row.querySelector(`[name=${name}]`).value = line[name];
    }
  }
  showMode();
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
const NOT_KEPT = ' This waiting send will be lost if the page is reloaded.';

let pending = null; // { payload, attempts, timer, kept }: a send not yet confirmed
let unsent = false; // the last send was refused because its session ended

function setWaiting(text) {
  setStatus(text + (pending && !pending.kept ? NOT_KEPT : ''), 'waiting');
}

// ---- A waiting send survives a reload ----------------------------------------
// Until the server replies, the send (the exact payload, PNG bytes and
// request ID included) is kept in sessionStorage, which belongs to this tab
// only. On load it is put back and sent again; the request ID makes sure it
// is saved once. It is removed as soon as the server replies.

const WAITING_KEY = 'rx-pending-send';

function keepWaitingSend(payload) {
  const image = payload.image ? bytesToBase64(payload.image) : undefined;
  const padSnapshot = payload.kind === 'handwritten' ? pad.snapshot() : undefined;
  try {
    sessionStorage.setItem(WAITING_KEY, JSON.stringify({ payload: { ...payload, image }, pad: padSnapshot }));
    return true;
  } catch {
    return false; // storage full or blocked: the send still goes, just not across a reload
  }
}

function forgetWaitingSend() {
  try {
    sessionStorage.removeItem(WAITING_KEY);
  } catch {
    // nothing kept
  }
}

function restoreWaitingSend() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(WAITING_KEY));
  } catch {
    saved = null;
  }
  if (!saved || !saved.payload) return;
  const payload = { ...saved.payload };
  if (payload.image) payload.image = base64ToBytes(payload.image);
  fillForm(payload, saved.pad);
  pending = { payload, attempts: 0, timer: null, kept: true };
  lockForm(true);
  trySend(); // or on 'connect'
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

function showUnsent(message) {
  unsent = Boolean(message);
  $('unsent-note').textContent = message || '';
  $('unsent-note').hidden = !message;
}

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
  // The session it is sent in: if that session has ended by the time it
  // arrives, the server refuses it instead of filing it in another one.
  const sending = { ...payload, requestId: newRequestId(), sessionId: session ? session.id : undefined };
  pending = { payload: sending, attempts: 0, timer: null, kept: false };
  pending.kept = keepWaitingSend(sending);
  lockForm(true);
  trySend();
});

function trySend() {
  if (!pending) return;
  clearTimeout(pending.timer);
  if (!socket.connected) return setWaiting(WAITING_OFFLINE); // 'connect' calls trySend
  const current = pending;
  const attempt = ++current.attempts;
  if (attempt === 1) setStatus('Sending…');
  socket.timeout(ACK_TIMEOUT_MS).emit('prescription:new', current.payload, (err, res) => {
    // A newer attempt (after a reconnect) has taken over from this one.
    if (pending !== current || current.attempts !== attempt) return;
    if (err) {
      setWaiting(socket.connected ? WAITING_NO_REPLY : WAITING_OFFLINE);
      if (socket.connected) current.timer = setTimeout(trySend, RETRY_MS);
      return;
    }
    pending = null;
    forgetWaitingSend();
    lockForm(false);
    if (!res.ok) {
      // Refused: everything stays in the form, to fix or send again.
      if (res.code === 'SESSION_ENDED') showUnsent(res.error);
      return showFormError(res.error);
    }
    showUnsent(null);
    store.upsert(res.prescription);
    renderList();
    setStatus(`Sent ${res.prescription.id} (${res.prescription.patientRef})`, 'success');
    resetForm();
  });
}

// Back online: send the waiting prescription again straight away, without
// waiting for the old attempt to time out.
socket.on('connect', trySend);
socket.on('disconnect', () => pending && setWaiting(WAITING_OFFLINE));

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
restoreWaitingSend();
