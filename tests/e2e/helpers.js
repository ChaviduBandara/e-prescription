// Page actions shared by the e2e specs.
'use strict';

const { expect } = require('./fixtures');

// Obviously fake, and unique per test so a shared server never confuses them.
function fakeRef(testInfo) {
  return `TOKEN-${testInfo.project.name.slice(0, 3).toUpperCase()}-${String(Date.now()).slice(-6)}`;
}

async function openDoctor(doctor) {
  await doctor.goto('/doctor/');
  await expect(doctor.locator('#conn')).toHaveText('Connected');
  await expect(doctor.locator('#no-session:visible, #session:visible')).toBeVisible();
}

// Opens the pharmacy screen and taps Start receiving, like the pharmacist
// does once per page load (it unlocks the alert sound).
async function openPharmacy(pharmacy) {
  await pharmacy.goto('/pharmacy/');
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');
  await pharmacy.getByRole('button', { name: 'Start receiving' }).click();
  await expect(pharmacy.locator('#no-session:visible, #queue-section:visible')).toBeVisible();
}

// Starts a session from the doctor screen, or carries on with the open one.
async function ensureSession(doctor) {
  const start = doctor.getByRole('button', { name: 'Start Session' });
  if (await start.isVisible()) await start.tap();
  await expect(doctor.locator('#session')).toBeVisible();
}

async function fillLine(doctor, n, { medicine = '', dosage = '', instructions = '' }) {
  await doctor.getByLabel(`Medicine, line ${n}`).fill(medicine);
  await doctor.getByLabel(`Dosage, line ${n}`).fill(dosage);
  await doctor.getByLabel(`Instructions, line ${n}`).fill(instructions);
}

// Draws one stroke on the handwriting canvas with the mouse. `points` are
// fractions of the canvas size, e.g. [[0.1, 0.2], [0.4, 0.25]].
async function drawStroke(doctor, points) {
  const box = await doctor.locator('#pad').boundingBox();
  const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
  await doctor.mouse.move(...at(points[0]));
  await doctor.mouse.down();
  for (const point of points.slice(1)) await doctor.mouse.move(...at(point), { steps: 8 });
  await doctor.mouse.up();
}

// Draws one stroke at exact canvas CSS-pixel positions, e.g.
// [[100, 50], [103, 50]]. `steps` is how many pointer moves each segment
// is split into: 1 means one jump, like a fast flick.
async function drawAt(doctor, points, { steps = 1 } = {}) {
  const pad = doctor.locator('#pad');
  // Mouse events outside the viewport go nowhere, so make sure every
  // point is on screen, like a doctor scrolling up to the pad.
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  const at = ([x, y]) => [box.x + x, box.y + y];
  const viewport = doctor.viewportSize();
  for (const [x, y] of points.map(at)) {
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
      throw new Error(`Point (${x}, ${y}) is off screen; the stroke would be lost`);
    }
  }
  await doctor.mouse.move(...at(points[0]));
  await doctor.mouse.down();
  for (const point of points.slice(1)) await doctor.mouse.move(...at(point), { steps });
  await doctor.mouse.up();
  // If the page scrolled while drawing (e.g. scroll anchoring settling
  // after a viewport change), the stroke landed somewhere else. Fail here
  // with a clear message rather than later as "missing ink".
  const after = await pad.boundingBox();
  if (Math.abs(after.x - box.x) > 0.5 || Math.abs(after.y - box.y) > 0.5) {
    throw new Error(`The pad moved while drawing: ${JSON.stringify(box)} -> ${JSON.stringify(after)}`);
  }
}

// Sends a typed prescription and returns its ID once the server confirms.
async function sendTyped(doctor, patientRef, medicine = 'Test Medicine 10mg') {
  await doctor.getByLabel('Patient ID or token').fill(patientRef);
  await fillLine(doctor, 1, { medicine, dosage: '1 tablet', instructions: 'Twice daily' });
  return sendAndGetId(doctor, patientRef);
}

// Switches the doctor form to Handwrite and fills the patient ref.
async function startHandwriting(doctor, patientRef) {
  const handwrite = doctor.getByRole('radio', { name: 'Handwrite' });
  await handwrite.tap();
  await expect(handwrite).toBeChecked();
  await expect(doctor.locator('#pad')).toBeVisible();
  await doctor.getByLabel('Patient ID or token').fill(patientRef);
}

// Taps Send and returns the new prescription ID once the server confirms.
async function sendAndGetId(doctor, patientRef) {
  await doctor.getByRole('button', { name: 'Send' }).tap();
  const status = doctor.locator('#send-status');
  await expect(status).toHaveText(new RegExp(`^Sent RX-\\d{8}-\\d{4,} \\(${patientRef}\\)$`));
  return (await status.textContent()).match(/RX-\d{8}-\d{4,}/)[0];
}

// Reads the PNG the server stored for `id` and returns, for each point,
// the highest alpha (0-255) in a box reaching `radius` CSS pixels around
// it (scaled by the PNG's pixel ratio, so it covers the same area at 1x
// and 2x). radius 0 = the single PNG pixel under the point. Points are in
// canvas CSS pixels as drawn; `cssWidth` is the canvas CSS width they were
// drawn at, used to map them onto the PNG's pixels.
async function inkAt(page, id, points, cssWidth, { radius = 1 } = {}) {
  return page.evaluate(
    async ({ url, points, cssWidth, radius }) => {
      const blob = await (await fetch(url, { cache: 'no-store' })).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / cssWidth;
      return points.map(([x, y]) => {
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        const r = Math.round(radius * scale);
        const { data } = ctx.getImageData(px - r, py - r, r * 2 + 1, r * 2 + 1);
        let max = 0;
        for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]);
        return max;
      });
    },
    { url: `/api/prescriptions/${id}/image`, points, cssWidth, radius }
  );
}

// The canvas's CSS size and its bitmap size.
async function padSize(doctor) {
  return doctor.locator('#pad').evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { cssWidth: r.width, cssHeight: r.height, width: c.width, height: c.height };
  });
}

module.exports = {
  fakeRef,
  openDoctor,
  openPharmacy,
  ensureSession,
  fillLine,
  drawStroke,
  drawAt,
  startHandwriting,
  sendAndGetId,
  sendTyped,
  inkAt,
  padSize
};
