// Shared Playwright fixtures: one browser context per role, sized like the
// real devices. Tests use `doctor` and `pharmacy` pages instead of `page`.
'use strict';

const base = require('@playwright/test');

const DOCTOR_CONTEXT = { viewport: { width: 1024, height: 1366 }, hasTouch: true };
const PHARMACY_CONTEXT = { viewport: { width: 1366, height: 768 } };

async function rolePage(browser, contextOptions, use) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await use(page);
  await context.close();
}

const test = base.test.extend({
  doctor: async ({ browser }, use) => rolePage(browser, DOCTOR_CONTEXT, use),
  pharmacy: async ({ browser }, use) => rolePage(browser, PHARMACY_CONTEXT, use)
});

module.exports = { test, expect: base.expect, DOCTOR_CONTEXT, PHARMACY_CONTEXT };
