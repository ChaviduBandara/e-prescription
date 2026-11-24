// Prescription IDs: RX-YYYYMMDD-NNNN, a running number per day (server
// local date). The next number is read from the database, so it survives
// restarts. Call nextPrescriptionId inside the same transaction as the
// insert so the read and the write cannot interleave.
'use strict';

const PREFIX = 'RX-';

function datePart(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatId(now, number) {
  return `${PREFIX}${datePart(now)}-${String(number).padStart(4, '0')}`;
}

function nextPrescriptionId(db, now = new Date()) {
  const dayPrefix = `${PREFIX}${datePart(now)}-`;
  // Compare numerically, not as text, so -10000 sorts after -9999.
  const row = db
    .prepare(
      `SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS last
         FROM prescriptions WHERE id LIKE ?`
    )
    .get(dayPrefix.length + 1, `${dayPrefix}%`);
  return formatId(now, (row.last || 0) + 1);
}

const ID_PATTERN = /^RX-\d{8}-\d{4,}$/;

module.exports = { nextPrescriptionId, formatId, datePart, ID_PATTERN };
