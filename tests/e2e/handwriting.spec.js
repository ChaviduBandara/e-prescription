// Scenario 3 from the e2e-handoff-test skill: a handwritten prescription
// reaches the pharmacy as an image, never as text.
'use strict';

const { test, expect } = require('./fixtures');
const { fakeRef, openDoctor, openPharmacy, ensureSession, drawStroke } = require('./helpers');

// Counts pixels in an <img> that are not fully transparent.
function inkedPixels(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let inked = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) inked += 1;
  return inked;
}

test('scenario 3: a handwritten prescription shows on the pharmacy screen as an image, not text', async ({
  doctor,
  pharmacy
}, testInfo) => {
  const patientRef = fakeRef(testInfo);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  const handwrite = doctor.getByRole('radio', { name: 'Handwrite' });
  await handwrite.tap();
  await expect(handwrite).toBeChecked();
  const pad = doctor.locator('#pad');
  await expect(pad).toBeVisible();
  await expect(doctor.getByLabel('Medicine, line 1')).toBeHidden();
  // Drawing must not scroll or zoom the page.
  await expect(pad).toHaveCSS('touch-action', 'none');
  // The canvas fills the form's width.
  const padBox = await pad.boundingBox();
  const formBox = await doctor.locator('#rx-form').boundingBox();
  expect(padBox.width).toBeGreaterThan(formBox.width - 60);

  const undo = doctor.getByRole('button', { name: 'Undo' });
  const clear = doctor.getByRole('button', { name: 'Clear' });
  const send = doctor.getByRole('button', { name: 'Send' });
  const status = doctor.locator('#send-status');
  await expect(undo).toBeDisabled();

  // An empty canvas is rejected.
  await doctor.getByLabel('Patient ID or token').fill(patientRef);
  await send.tap();
  await expect(status).toHaveText('Draw the prescription before sending.');
  await expect(doctor.locator('.pad')).toHaveClass(/pad--invalid/);

  // Undo removes one stroke; Clear removes all.
  await drawStroke(doctor, [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]]);
  await drawStroke(doctor, [[0.1, 0.4], [0.4, 0.45]]);
  await expect(undo).toBeEnabled();
  await undo.tap();
  await expect(undo).toBeEnabled();
  await clear.tap();
  await expect(undo).toBeDisabled();

  // Draw the real prescription and send it.
  await drawStroke(doctor, [[0.08, 0.15], [0.2, 0.1], [0.3, 0.2], [0.45, 0.12]]);
  await drawStroke(doctor, [[0.08, 0.35], [0.25, 0.4], [0.6, 0.33]]);
  await drawStroke(doctor, [[0.08, 0.55], [0.15, 0.6], [0.3, 0.52]]);
  await expect(doctor.locator('.pad')).not.toHaveClass(/pad--invalid/);
  await send.tap();

  await expect(status).toHaveText(new RegExp(`^Sent RX-\\d{8}-\\d{4,} \\(${patientRef}\\)$`));
  const id = (await status.textContent()).match(/RX-\d{8}-\d{4,}/)[0];
  // The form is ready for the next patient, still in Handwrite mode.
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue('');
  await expect(undo).toBeDisabled();
  await expect(pad).toBeVisible();
  await expect(doctor.locator(`#sent-list [data-rx-id="${id}"] .summary`)).toHaveText('Handwritten');

  // The pharmacy shows an <img> with the drawing, and no typed lines.
  const card = pharmacy.locator(`[data-rx-id="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(patientRef);
  const img = card.locator('img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', `/api/prescriptions/${id}/image`);
  await expect.poll(() => img.evaluate((node) => node.complete && node.naturalWidth)).toBeGreaterThan(0);
  expect(await img.evaluate(inkedPixels)).toBeGreaterThan(50);
  await expect(card.locator('table, td, .rx-lines')).toHaveCount(0);
  // Readable size: as wide as the card's content.
  expect((await img.boundingBox()).width).toBeGreaterThan(800);

  await expect(pharmacy.locator('#notice')).toContainText(id);
  await expect.poll(() => pharmacy.evaluate(() => window.__alertPlays)).toBeGreaterThanOrEqual(1);

  // Tapping the image opens it full screen; Close and Escape dismiss it.
  const viewer = pharmacy.locator('#viewer');
  await img.click();
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveAttribute('src', `/api/prescriptions/${id}/image`);
  const viewerBox = await viewer.boundingBox();
  expect(viewerBox.width).toBe(1366);
  expect(viewerBox.height).toBe(768);
  await pharmacy.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
  await img.click();
  await expect(viewer).toBeVisible();
  await pharmacy.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  // A fresh pharmacy screen loads the image from the server.
  await pharmacy.reload();
  const reloaded = pharmacy.locator(`[data-rx-id="${id}"] img`);
  await expect.poll(() => reloaded.evaluate((node) => node.complete && node.naturalWidth)).toBeGreaterThan(0);
});
