// Validates a typed prescription from the doctor screen. Returns
// { ok: true, value } with cleaned data, or { ok: false, error } with a
// message that can be shown to the doctor as-is.
'use strict';

const LIMITS = {
  patientRef: 40,
  lines: 30,
  medicine: 200,
  dosage: 200,
  instructions: 500
};

const ERRORS = {
  invalid: 'Invalid prescription. Reload the page and try again.',
  patientRef: 'Patient ID or token number is required.',
  patientRefTooLong: `Patient ID or token number must be ${LIMITS.patientRef} characters or fewer.`,
  noLines: 'Add at least one medicine.',
  tooManyLines: `A prescription can have at most ${LIMITS.lines} lines.`
};

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateTypedPrescription(payload) {
  if (!payload || typeof payload !== 'object') return fail(ERRORS.invalid);

  const patientRef = clean(payload.patientRef);
  if (!patientRef) return fail(ERRORS.patientRef);
  if (patientRef.length > LIMITS.patientRef) return fail(ERRORS.patientRefTooLong);

  if (!Array.isArray(payload.lines)) return fail(ERRORS.noLines);

  const lines = [];
  for (const [index, raw] of payload.lines.entries()) {
    if (!raw || typeof raw !== 'object') return fail(ERRORS.invalid);
    const line = {
      medicine: clean(raw.medicine),
      dosage: clean(raw.dosage),
      instructions: clean(raw.instructions)
    };
    if (!line.medicine && !line.dosage && !line.instructions) continue; // blank row
    const n = index + 1;
    if (!line.medicine) return fail(`Line ${n}: medicine name is required.`);
    for (const field of ['medicine', 'dosage', 'instructions']) {
      if (line[field].length > LIMITS[field]) {
        return fail(`Line ${n}: ${field} must be ${LIMITS[field]} characters or fewer.`);
      }
    }
    lines.push(line);
  }

  if (lines.length === 0) return fail(ERRORS.noLines);
  if (lines.length > LIMITS.lines) return fail(ERRORS.tooManyLines);

  return { ok: true, value: { patientRef, lines } };
}

function fail(error) {
  return { ok: false, error };
}

module.exports = { validateTypedPrescription, LIMITS, ERRORS };
