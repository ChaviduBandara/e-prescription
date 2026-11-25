// Scenarios from the e2e-handoff-test skill. The doctor is an upright iPad
// (touch), the pharmacy a 1366x768 desktop.
'use strict';

const { test, expect } = require('./fixtures');
const { fakeRef, openDoctor, openPharmacy, ensureSession, fillLine } = require('./helpers');

function todayPart() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

test('scenario 2: typed prescription reaches the pharmacy within 1 s with an ID, a notice and a sound', async ({
  doctor,
  pharmacy
}, testInfo) => {
  const patientRef = fakeRef(testInfo);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  await expect(pharmacy.locator('#queue-section')).toBeVisible();
  // Start receiving unlocks sound with one muted play(); count from here.
  const playsBefore = await pharmacy.evaluate(() => window.__alertPlays);

  await doctor.getByLabel('Patient ID or token').fill(patientRef);
  await fillLine(doctor, 1, { medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily' });
  await doctor.getByRole('button', { name: '+ Add line' }).tap();
  await fillLine(doctor, 2, { medicine: 'Test Syrup 5ml', dosage: '5 ml', instructions: 'At night' });

  await doctor.getByRole('button', { name: 'Send' }).tap();

  // Doctor sees "Sent" with the server-assigned ID.
  const status = doctor.locator('#send-status');
  await expect(status).toHaveText(new RegExp(`^Sent RX-${todayPart()}-\\d{4,} \\(${patientRef}\\)$`));
  const id = (await status.textContent()).match(/RX-\d{8}-\d{4,}/)[0];

  // Pharmacy shows the card within 1 s of tapping Send, timed inside the
  // browsers so Playwright's own overhead is not counted.
  const card = pharmacy.locator(`[data-rx-id="${id}"]`);
  await expect(card).toBeVisible();
  const [sentAt] = await doctor.evaluate(() => window.__submits);
  const arrivedAt = await pharmacy.evaluate((rxId) => window.__arrivals[rxId], id);
  testInfo.annotations.push({ type: 'latency', description: `${arrivedAt - sentAt} ms` });
  console.log(`[${testInfo.project.name}] send-to-pharmacy latency: ${arrivedAt - sentAt} ms`);
  expect(arrivedAt - sentAt).toBeLessThan(1000);

  await expect(card).toContainText(patientRef);
  await expect(card.locator('tbody tr')).toHaveCount(2);
  await expect(card.locator('tbody tr').nth(0)).toHaveText(/Test Medicine 10mg\s*1 tablet\s*Twice daily/);
  await expect(card.locator('tbody tr').nth(1)).toHaveText(/Test Syrup 5ml\s*5 ml\s*At night/);
  await expect(card.locator('.badge')).toHaveText('Waiting');
  // Newest is last in the queue (arrival order).
  await expect(pharmacy.locator('#queue > li').last()).toHaveAttribute('data-rx-id', id);

  // Notice and alert sound: exactly one play() for one prescription.
  const notice = pharmacy.locator('#notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`New prescription ${id} for ${patientRef}`);
  await expect.poll(() => pharmacy.evaluate(() => window.__alertPlays)).toBe(playsBefore + 1);

  // Doctor's list shows it as Sent, and the form is ready for the next patient.
  const item = doctor.locator(`#sent-list [data-rx-id="${id}"]`);
  await expect(item).toContainText(patientRef);
  await expect(item.locator('.badge')).toHaveText('Sent');
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue('');

  // The notice stays until the pharmacist clicks it.
  await notice.click();
  await expect(notice).toBeHidden();

  // A fresh pharmacy screen loads the same prescription from the server
  // once Start receiving is tapped.
  await pharmacy.reload();
  await expect(pharmacy.getByRole('button', { name: 'Start receiving' })).toBeVisible();
  await expect(pharmacy.locator('#queue-section')).toBeHidden();
  await pharmacy.getByRole('button', { name: 'Start receiving' }).click();
  await expect(pharmacy.locator(`[data-rx-id="${id}"]`)).toContainText(patientRef);
});

test('scenario 9: a typed prescription without a patient ID is rejected with a clear message', async ({
  doctor,
  pharmacy
}, testInfo) => {
  const medicine = `Test Medicine 20mg ${fakeRef(testInfo)}`;
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  await fillLine(doctor, 1, { medicine, dosage: '1 tablet', instructions: 'Once daily' });
  await doctor.getByRole('button', { name: 'Send' }).tap();

  const status = doctor.locator('#send-status');
  await expect(status).toHaveText('Patient ID or token number is required.');
  await expect(status).toHaveClass(/msg--error/);
  const patientInput = doctor.getByLabel('Patient ID or token');
  await expect(patientInput).toHaveAttribute('aria-invalid', 'true');
  await expect(patientInput).toBeFocused();
  // Nothing typed is lost.
  await expect(doctor.getByLabel('Medicine, line 1')).toHaveValue(medicine);

  // Fix it and send: exactly one card with this medicine reaches the
  // pharmacy, proving the rejected attempt never did.
  const patientRef = fakeRef(testInfo);
  await patientInput.fill(patientRef);
  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(status).toHaveText(/^Sent RX-/);
  const cards = pharmacy.locator('#queue > li', { hasText: medicine });
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(patientRef);
});
