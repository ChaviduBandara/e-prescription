// Socket.IO events from docs/SPEC.md. Every handler saves to SQLite first,
// then acks the sender, then broadcasts (hard rule 3).
'use strict';

const { startSession } = require('./sessions');
const {
  createTypedPrescription,
  createHandwrittenPrescription,
  NoOpenSessionError
} = require('./prescriptions');
const { validatePrescription } = require('./validation');

const SERVER_ERROR = 'Server error. The prescription was NOT saved. Try again.';

// `dataDir` is where handwriting PNGs are saved (DATA_DIR/images/).
function registerSocketHandlers(io, db, { dataDir }) {
  io.on('connection', (socket) => {
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
  });
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

module.exports = { registerSocketHandlers };
