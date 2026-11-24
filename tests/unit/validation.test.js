'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTypedPrescription, LIMITS, ERRORS } = require('../../src/validation');
const { fakeTyped } = require('../helpers');

const validate = validateTypedPrescription;

test('accepts a valid typed prescription and trims every field', () => {
  const result = validate({
    patientRef: '  TOKEN-001 ',
    lines: [{ medicine: ' Test Medicine 10mg ', dosage: ' 1 tablet', instructions: 'Twice daily ' }]
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      patientRef: 'TOKEN-001',
      lines: [{ medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily' }]
    }
  });
});

test('dosage and instructions are optional', () => {
  const result = validate(fakeTyped({ lines: [{ medicine: 'Test Medicine 5mg' }] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.lines, [{ medicine: 'Test Medicine 5mg', dosage: '', instructions: '' }]);
});

test('rejects a missing, empty or blank patient ref', () => {
  for (const patientRef of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(validate(fakeTyped({ patientRef })), { ok: false, error: ERRORS.patientRef });
  }
});

test('rejects a patient ref that is too long', () => {
  const result = validate(fakeTyped({ patientRef: 'T'.repeat(LIMITS.patientRef + 1) }));
  assert.equal(result.ok, false);
  assert.equal(result.error, ERRORS.patientRefTooLong);
});

test('rejects a prescription with no medicine lines', () => {
  for (const lines of [undefined, [], [{ medicine: '', dosage: '', instructions: '  ' }], 'x']) {
    assert.deepEqual(validate(fakeTyped({ lines })), { ok: false, error: ERRORS.noLines });
  }
});

test('drops blank rows but keeps the rest in order', () => {
  const result = validate(
    fakeTyped({
      lines: [{ medicine: 'Test Medicine A' }, { medicine: '', dosage: '' }, { medicine: 'Test Medicine B' }]
    })
  );
  assert.deepEqual(result.value.lines.map((l) => l.medicine), ['Test Medicine A', 'Test Medicine B']);
});

test('a line with dosage but no medicine names the line', () => {
  const result = validate(fakeTyped({ lines: [{ medicine: 'Test Medicine A' }, { dosage: '1 tablet' }] }));
  assert.deepEqual(result, { ok: false, error: 'Line 2: medicine name is required.' });
});

test('rejects over-long fields and too many lines', () => {
  assert.match(validate(fakeTyped({ lines: [{ medicine: 'M'.repeat(201) }] })).error, /Line 1: medicine/);
  assert.match(
    validate(fakeTyped({ lines: [{ medicine: 'Test', instructions: 'I'.repeat(501) }] })).error,
    /Line 1: instructions/
  );
  const many = Array.from({ length: LIMITS.lines + 1 }, () => ({ medicine: 'Test Medicine' }));
  assert.equal(validate(fakeTyped({ lines: many })).error, ERRORS.tooManyLines);
});

test('rejects payloads that are not objects', () => {
  for (const payload of [undefined, null, 'TOKEN-001', 7]) {
    assert.deepEqual(validate(payload), { ok: false, error: ERRORS.invalid });
  }
  assert.equal(validate(fakeTyped({ lines: ['Test Medicine'] })).error, ERRORS.invalid);
});

test('ignores unknown fields', () => {
  const result = validate({ ...fakeTyped(), kind: 'handwritten', id: 'RX-HACK' });
  assert.deepEqual(Object.keys(result.value), ['patientRef', 'lines']);
});
