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

async function openPharmacy(pharmacy) {
  await pharmacy.goto('/pharmacy/');
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');
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

module.exports = { fakeRef, openDoctor, openPharmacy, ensureSession, fillLine };
