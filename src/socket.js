// Socket.IO events from docs/SPEC.md. Every handler saves to SQLite first,
// then acks the sender, then broadcasts (hard rule 3).
'use strict';

const { startSession, endSession, SessionNotOpenError } = require('./sessions');
const { ID_PATTERN } = require('./ids');
const {
  createTypedPrescription,
  createHandwrittenPrescription,
  markDispensed,
  NoOpenSessionError,
  NotDispensableError
} = require('./prescriptions');
const { validatePrescription } = require('./validation');

const SERVER_ERROR = 'Server error. The prescription was NOT saved. Try again.';

// Which role may send each event. Anything else is refused with an ack.
const PERMISSIONS = {
  'session:start': 'doctor',
  'prescription:new': 'doctor',
  'prescription:dispensed': 'pharmacy',
  'session:end': 'pharmacy'
};
const NOT_ALLOWED = 'This screen is not allowed to do that.';

// Every connection must say which screen it is (handshake auth.role) and
// carry a valid login cookie for that role. Browsers send the cookie with
// the handshake; the Origin check stops another site from borrowing it.
function authenticateSockets(io, auth) {
  io.use((socket, next) => {
    const { headers } = socket.request;
    if (headers.origin) {
      let originHost;
      try {
        originHost = new URL(headers.origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== headers.host) return next(new Error('unauthorized'));
    }
    const role = socket.handshake.auth && socket.handshake.auth.role;
    if (auth.rolesFromCookieHeader(headers.cookie, [role]).length !== 1) return next(new Error('unauthorized'));
    socket.data.role = role;
    next();
  });
}

// `dataDir` is where handwriting PNGs are saved (DATA_DIR/images/).
function registerSocketHandlers(io, db, { dataDir, auth }) {
  authenticateSockets(io, auth);
  io.on('connection', (socket) => {
    // Refuse events this role may not send, before any handler runs.
    socket.use(([event, ...args], next) => {
      const allowed = PERMISSIONS[event];
      if (!allowed || allowed === socket.data.role) return next();
      const ack = args[args.length - 1];
      if (typeof ack === 'function') ack({ ok: false, error: NOT_ALLOWED });
    });

    socket.on('session:start', (_payload, ack) => {
      // Accept both emit('session:start', ack) and emit('session:start', {}, ack).
      if (typeof _payload === 'function') ack = _payload;
      const reply = safeAck(ack);
      try {
        const { session, created } = startSession(db);
        reply({ ok: true, session });
        if (created) io.emit('session:started', session);
      } catch (err) {
        console.error('session:start failed:', err.message);
        reply({ ok: false, error: 'Server error. Could not start the session.' });
      }
    });

    socket.on('prescription:new', (payload, ack) => {
      const reply = safeAck(ack);
      const result = validatePrescription(payload);
      if (!result.ok) return reply({ ok: false, error: result.error });

      let prescription;
      try {
        prescription =
          result.value.kind === 'handwritten'
            ? createHandwrittenPrescription(db, dataDir, result.value)
            : createTypedPrescription(db, result.value);
      } catch (err) {
        if (err instanceof NoOpenSessionError) return reply({ ok: false, error: err.message });
        console.error('prescription:new failed:', err.message);
        return reply({ ok: false, error: SERVER_ERROR });
      }
      // Logged by ID only: no patient data in logs.
      console.log(`saved ${prescription.id}`);
      reply({ ok: true, prescription });
      io.emit('prescription:new', prescription);
    });

    socket.on('prescription:dispensed', (payload, ack) => {
      const reply = safeAck(ack);
      const id = payload && payload.id;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        return reply({ ok: false, error: 'Unknown prescription ID.' });
      }
      let result;
      try {
        result = markDispensed(db, id);
      } catch (err) {
        if (err instanceof NotDispensableError) return reply({ ok: false, error: err.message });
        console.error('prescription:dispensed failed:', err.message);
        return reply({ ok: false, error: 'Server error. NOT marked dispensed. Try again.' });
      }
      if (result.changed) console.log(`dispensed ${id}`);
      reply({ ok: true, prescription: result.prescription });
      if (result.changed) io.emit('prescription:dispensed', result.prescription);
    });

    // Closes the session. The PDF archive is added in phase 6.
    socket.on('session:end', (payload, ack) => {
      const reply = safeAck(ack);
      const id = payload && payload.sessionId;
      if (!Number.isSafeInteger(id) || id < 1) return reply({ ok: false, error: 'Unknown session.' });
      let result;
      try {
        result = endSession(db, id);
      } catch (err) {
        if (err instanceof SessionNotOpenError) return reply({ ok: false, error: err.message });
        console.error('session:end failed:', err.message);
        return reply({ ok: false, error: 'Server error. The session is still open. Try again.' });
      }
      if (result.closed) console.log(`ended session ${id}`);
      reply({ ok: true, session: result.session });
      if (result.closed) io.emit('session:ended', result.session);
    });
  });
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

module.exports = { registerSocketHandlers };
