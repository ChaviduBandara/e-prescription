// Short handwritten marks must reach the pharmacy intact. A missing
// decimal point, dash or flick can change a dose, so each test draws one
// mark, sends it, and checks the PNG the server stored has ink exactly
// where the mark was drawn. Positions are canvas CSS pixels.
'use strict';

const { test, expect } = require('./fixtures');
const { fakeRef, openDoctor, ensureSession, drawAt, startHandwriting, sendAndGetId, inkAt, padSize } = require('./helpers');

// Somewhere nothing is ever drawn in these tests.
const EMPTY = [800, 600];

async function setup(doctor, testInfo) {
  const patientRef = fakeRef(testInfo);
  await openDoctor(doctor);
  await ensureSession(doctor);
  await startHandwriting(doctor, patientRef);
  const { cssWidth } = await padSize(doctor);
  return { patientRef, cssWidth };
}

test('a single tap (decimal point) leaves a dot where it was tapped', async ({ doctor }, testInfo) => {
  const { patientRef, cssWidth } = await setup(doctor, testInfo);
  await drawAt(doctor, [[100, 100]]);
  const id = await sendAndGetId(doctor, patientRef);

  const [dot, empty] = await inkAt(doctor, id, [[100, 100], EMPTY], cssWidth);
  expect(dot, 'ink at the tap').toBeGreaterThan(128);
  expect(empty, 'no ink where nothing was drawn').toBe(0);
});

test('a 3-pixel dash is drawn all the way to its end', async ({ doctor }, testInfo) => {
  const { patientRef, cssWidth } = await setup(doctor, testInfo);
  await drawAt(doctor, [[200, 100], [203, 100]]);
  const id = await sendAndGetId(doctor, patientRef);

  // The single end pixel: outside the start dot (radius 2.1 px), so it
  // only has ink if the dash itself was drawn.
  const [start] = await inkAt(doctor, id, [[200, 100]], cssWidth);
  const [end] = await inkAt(doctor, id, [[203, 100]], cssWidth, { radius: 0 });
  expect(start, 'ink at the start').toBeGreaterThan(128);
  expect(end, 'ink at the end of the dash').toBeGreaterThan(128);
});

test('a fast flick (one jump between pen down and up) is drawn as a line', async ({ doctor }, testInfo) => {
  const { patientRef, cssWidth } = await setup(doctor, testInfo);
  await drawAt(doctor, [[100, 300], [400, 300]], { steps: 1 });
  const id = await sendAndGetId(doctor, patientRef);

  const [start, middle, end, empty] = await inkAt(doctor, id, [[100, 300], [250, 300], [400, 300], EMPTY], cssWidth);
  expect(start, 'ink at the start').toBeGreaterThan(128);
  expect(middle, 'ink in the middle').toBeGreaterThan(128);
  expect(end, 'ink at the end').toBeGreaterThan(128);
  expect(empty, 'no ink where nothing was drawn').toBe(0);
});

test('the last segment of a normal stroke is drawn', async ({ doctor }, testInfo) => {
  const { patientRef, cssWidth } = await setup(doctor, testInfo);
  // A small wiggle, then one long final jump to the right.
  await drawAt(doctor, [[100, 450], [110, 455], [120, 450], [130, 455], [500, 450]], { steps: 1 });
  const id = await sendAndGetId(doctor, patientRef);

  const [wiggle, lastMiddle, lastEnd] = await inkAt(doctor, id, [[115, 452], [320, 452], [500, 450]], cssWidth);
  expect(wiggle, 'ink on the early part').toBeGreaterThan(128);
  expect(lastMiddle, 'ink along the last segment').toBeGreaterThan(128);
  expect(lastEnd, 'ink at the last point').toBeGreaterThan(128);
});

test('after Undo, the remaining strokes are redrawn in full, flicks included', async ({ doctor }, testInfo) => {
  const { patientRef, cssWidth } = await setup(doctor, testInfo);
  await drawAt(doctor, [[100, 200], [400, 200]], { steps: 1 }); // a flick: kept
  await drawAt(doctor, [[100, 260], [110, 265], [120, 260], [500, 260]], { steps: 1 }); // kept
  await drawAt(doctor, [[100, 330], [400, 330]], { steps: 1 }); // undone
  await doctor.getByRole('button', { name: 'Undo' }).tap();
  const id = await sendAndGetId(doctor, patientRef);

  const [flickMiddle, flickEnd, strokeEnd, undone] = await inkAt(
    doctor,
    id,
    [[250, 200], [400, 200], [500, 260], [250, 330]],
    cssWidth
  );
  expect(flickMiddle, 'kept flick, middle').toBeGreaterThan(128);
  expect(flickEnd, 'kept flick, end').toBeGreaterThan(128);
  expect(strokeEnd, 'kept stroke, last segment').toBeGreaterThan(128);
  expect(undone, 'undone stroke is gone').toBe(0);
});
