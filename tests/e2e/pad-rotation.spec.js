// Rotating the iPad (or any change to the pad's on-screen size) must never
// cut off or move a stroke. The pad locks behind a message instead and the
// drawing is untouched when the iPad is back upright. Positions are canvas
// CSS pixels.
'use strict';

const { test, expect, DOCTOR_CONTEXT } = require('./fixtures');
const { fakeRef, openDoctor, ensureSession, drawAt, startHandwriting, sendAndGetId, inkAt, padSize } = require('./helpers');

const PORTRAIT = DOCTOR_CONTEXT.viewport; // 1024x1366
const LANDSCAPE = { width: PORTRAIT.height, height: PORTRAIT.width };
const SPLIT_VIEW = { width: 768, height: PORTRAIT.height };
const TOOLBAR_CHANGE = { width: PORTRAIT.width, height: PORTRAIT.height - 120 };

test('rotating mid-drawing keeps every stroke exactly where it was drawn', async ({ doctor }, testInfo) => {
  const patientRef = fakeRef(testInfo);
  await openDoctor(doctor);
  await ensureSession(doctor);
  await startHandwriting(doctor, patientRef);

  const before = await padSize(doctor);
  const { cssWidth: w, cssHeight: h } = before;
  // Near the right edge, near the bottom edge, in the bottom-right corner
  // and in the middle: the places a resize would cut off or shift.
  const right = [w - 8, 60];
  const bottom = [120, h - 8];
  const corner = [w - 10, h - 10];
  const middle = [w / 2, h / 2];
  await drawAt(doctor, [[w - 60, 40], right, [w - 8, 120]], { steps: 6 });
  await drawAt(doctor, [[60, h - 20], bottom, [200, h - 10]], { steps: 6 });
  await drawAt(doctor, [[w - 40, h - 40], corner]);
  await drawAt(doctor, [[w / 2 - 50, h / 2], middle, [w / 2 + 50, h / 2]], { steps: 6 });

  const locked = doctor.locator('#pad-locked');
  const send = doctor.getByRole('button', { name: 'Send' });
  const status = doctor.locator('#send-status');
  const bitmap = async () => doctor.locator('#pad').evaluate((c) => [c.width, c.height]);
  const originalBitmap = await bitmap();

  // Landscape: locked with a clear message, bitmap untouched, cannot send.
  await doctor.setViewportSize(LANDSCAPE);
  await expect(locked).toBeVisible();
  await expect(locked).toHaveText('Rotate back to portrait to continue.');
  await expect(doctor.getByRole('button', { name: 'Undo' })).toBeDisabled();
  expect(await bitmap()).toEqual(originalBitmap);
  await send.tap();
  await expect(status).toHaveText('Rotate back to portrait to continue.');
  await expect(status).toHaveClass(/msg--error/);

  // Narrower portrait (iPad Split View): still locked.
  await doctor.setViewportSize(SPLIT_VIEW);
  await expect(locked).toBeVisible();
  await expect(locked).toHaveText('Make the browser full screen in portrait to continue.');
  expect(await bitmap()).toEqual(originalBitmap);

  // Only the height changes (Safari's toolbar): the pad does not care.
  await doctor.setViewportSize(TOOLBAR_CHANGE);
  await expect(locked).toBeHidden();
  expect(await bitmap()).toEqual(originalBitmap);

  // Back upright: unlocked, same size, keep writing, then send.
  await doctor.setViewportSize(PORTRAIT);
  await expect(locked).toBeHidden();
  expect(await padSize(doctor)).toEqual(before);
  const after = [w / 2, 80];
  await drawAt(doctor, [[w / 2 - 40, 80], after], { steps: 6 });
  const id = await sendAndGetId(doctor, patientRef);

  // Every stroke is in the stored PNG at the place it was drawn, and an
  // undrawn area is still empty.
  const empty = [w / 4, h / 4];
  const ink = await inkAt(doctor, id, [right, bottom, corner, middle, after, empty], w);
  for (const [i, name] of ['right edge', 'bottom edge', 'corner', 'middle', 'stroke after rotating'].entries()) {
    expect(ink[i], `ink at ${name}`).toBeGreaterThan(128);
  }
  expect(ink[5], 'no ink where nothing was drawn').toBe(0);

  // The PNG is the original bitmap, never resized.
  const pngSize = await doctor.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    return [bitmap.width, bitmap.height];
  }, `/api/prescriptions/${id}/image`);
  expect(pngSize).toEqual(originalBitmap);
});

test('handwriting cannot start in landscape; it unlocks in portrait', async ({ doctor }, testInfo) => {
  await openDoctor(doctor);
  await ensureSession(doctor);
  await doctor.setViewportSize(LANDSCAPE);
  await startHandwriting(doctor, fakeRef(testInfo));
  await expect(doctor.locator('#pad-locked')).toHaveText('Rotate back to portrait to continue.');
  await doctor.setViewportSize(PORTRAIT);
  await expect(doctor.locator('#pad-locked')).toBeHidden();
  // An empty pad resizes to fit the portrait box exactly, at device resolution.
  const size = await padSize(doctor);
  const ratio = await doctor.evaluate(() => Math.max(window.devicePixelRatio || 1, 1));
  expect(size.width).toBe(Math.round(size.cssWidth * ratio));
  expect(size.height).toBe(Math.round(size.cssHeight * ratio));
});
