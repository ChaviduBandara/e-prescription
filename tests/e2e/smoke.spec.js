'use strict';

const { test, expect } = require('./fixtures');

test('doctor page loads at tablet size', async ({ doctor }) => {
  await doctor.goto('/doctor/');
  await expect(doctor.locator('h1')).toHaveText('Doctor');
});

test('pharmacy page loads at desktop size', async ({ pharmacy }) => {
  await pharmacy.goto('/pharmacy/');
  await expect(pharmacy.locator('h1')).toHaveText('Pharmacy');
});
