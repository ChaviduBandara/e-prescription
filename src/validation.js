// Validates prescriptions from the doctor screen. Each validator returns
// { ok: true, value } with cleaned data, or { ok: false, error } with a
// message that can be shown to the doctor as-is.
'use strict';

const { inspectPng, MAX_IMAGE_BYTES } = require('./png');

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
  tooManyLines: `A prescription can have at most ${LIMITS.lines} lines.`,
  noDrawing: 'Draw the prescription before sending.',
  imageTooLarge: `The drawing is too large (over ${MAX_IMAGE_BYTES / 1024 / 1024} MB). Clear it and draw again.`,
  imageInvalid: 'The drawing could not be read. Clear it and draw again.'
};

const IMAGE_ERRORS = { blank: ERRORS.noDrawing, 'too-large': ERRORS.imageTooLarge, invalid: ERRORS.imageInvalid };

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Picks the validator by `kind`. A payload without `kind` is typed, as
// sent by phase 2 screens.
function validatePrescription(payload) {
  if (!payload || typeof payload !== 'object') return fail(ERRORS.invalid);
  const kind = payload.kind === undefined ? 'typed' : payload.kind;
  if (kind === 'typed') return validateTypedPrescription(payload);
  if (kind === 'handwritten') return validateHandwrittenPrescription(payload);
  return fail(ERRORS.invalid);
}

// Returns the error message, or null if the patient ref is fine.
function checkPatientRef(patientRef) {
  if (!patientRef) return ERRORS.patientRef;
  if (patientRef.length > LIMITS.patientRef) return ERRORS.patientRefTooLong;
  return null;
}

function validateTypedPrescription(payload) {
  if (!payload || typeof payload !== 'object') return fail(ERRORS.invalid);

  const patientRef = clean(payload.patientRef);
  const refError = checkPatientRef(patientRef);
  if (refError) return fail(refError);

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

  return { ok: true, value: { kind: 'typed', patientRef, lines } };
}

// `image` is the PNG exactly as the canvas exported it. Socket.IO delivers
// binary data to Node as a Buffer. The bytes are stored unchanged.
function validateHandwrittenPrescription(payload) {
  if (!payload || typeof payload !== 'object') return fail(ERRORS.invalid);

  const patientRef = clean(payload.patientRef);
  const refError = checkPatientRef(patientRef);
  if (refError) return fail(refError);

  if (payload.image === undefined || payload.image === null) return fail(ERRORS.noDrawing);
  const png = inspectPng(payload.image);
  if (!png.ok) return fail(IMAGE_ERRORS[png.reason]);

  return { ok: true, value: { kind: 'handwritten', patientRef, image: payload.image } };
}

function fail(error) {
  return { ok: false, error };
}

module.exports = {
  validatePrescription,
  validateTypedPrescription,
  validateHandwrittenPrescription,
  LIMITS,
  ERRORS
};
