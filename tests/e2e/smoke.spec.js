'use strict';

const { test, expect } = require('@playwright/test');

test('doctor page loads', async ({ page }) => {
  await page.goto('/doctor/');
  await expect(page.locator('h1')).toHaveText('Doctor');
});

test('pharmacy page loads', async ({ page }) => {
  await page.goto('/pharmacy/');
  await expect(page.locator('h1')).toHaveText('Pharmacy');
});
