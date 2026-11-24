'use strict';

const { test, expect } = require('./fixtures');
const { openDoctor, openPharmacy } = require('./helpers');

test('doctor page loads at tablet size and connects', async ({ doctor }) => {
  await openDoctor(doctor);
  await expect(doctor.locator('h1')).toHaveText('Doctor');
});

test('pharmacy page loads at desktop size and connects', async ({ pharmacy }) => {
  await openPharmacy(pharmacy);
  await expect(pharmacy.locator('h1')).toHaveText('Pharmacy');
});
