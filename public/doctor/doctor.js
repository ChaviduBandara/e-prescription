// Doctor screen: start a session, send typed prescriptions, see their status.
import { el, formatTime, sessionLabel, connectSocket, PrescriptionStore } from '/shared/client.js';

const ACK_TIMEOUT_MS = 8000;
const PATIENT_ERROR = 'Patient ID or token number is required.';

const $ = (id) => document.getElementById(id);
const store = new PrescriptionStore();
let session = null;

const socket = connectSocket({
  statusEl: $('conn'),
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

// ---- Session -------------------------------------------------------------

function setSession(s) {
  session = s;
  $('loading').hidden = true;
  $('no-session').hidden = Boolean(s);
  $('session').hidden = !s;
  $('session-label').textContent = sessionLabel(s);
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

function readForm() {
  const lines = [...$('lines').children].map((row) => ({
    medicine: row.querySelector('[name=medicine]').value,
    dosage: row.querySelector('[name=dosage]').value,
    instructions: row.querySelector('[name=instructions]').value
  }));
  return { patientRef: $('patient-ref').value, lines };
}

function resetForm() {
  $('patient-ref').value = '';
  $('patient-ref').removeAttribute('aria-invalid');
  $('lines').replaceChildren();
  addLine();
}

function setStatus(text, kind) {
  const status = $('send-status');
  status.textContent = text;
  status.className = `msg${kind ? ` msg--${kind}` : ''}`;
}

$('add-line').addEventListener('click', () => addLine().querySelector('input').focus());

$('rx-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected) {
    setStatus('Offline: NOT sent. Check the WiFi and try again.', 'error');
    return;
  }
  const send = $('send');
  send.disabled = true;
  setStatus('Sending…');
  $('patient-ref').removeAttribute('aria-invalid');

  socket.timeout(ACK_TIMEOUT_MS).emit('prescription:new', readForm(), (err, res) => {
    send.disabled = false;
    if (err) {
      setStatus('No reply from the pharmacy PC. Check the list below before sending again.', 'error');
      return;
    }
    if (!res.ok) {
      setStatus(res.error, 'error');
      if (res.error === PATIENT_ERROR) {
        $('patient-ref').setAttribute('aria-invalid', 'true');
        $('patient-ref').focus();
      }
      return;
    }
    store.upsert(res.prescription);
    renderList();
    setStatus(`Sent ${res.prescription.id} (${res.prescription.patientRef})`, 'success');
    resetForm();
  });
});

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
        el('span', { className: 'summary' }, rx.lines.map((l) => l.medicine).join(', '))
      )
    )
  );
}

resetForm();
