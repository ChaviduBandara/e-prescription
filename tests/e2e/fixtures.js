// Shared Playwright fixtures: one browser context per role, sized like the
// real devices. Tests use `doctor` and `pharmacy` pages instead of `page`.
'use strict';

const base = require('@playwright/test');

const DOCTOR_CONTEXT = { viewport: { width: 1024, height: 1366 }, hasTouch: true };
const PHARMACY_CONTEXT = { viewport: { width: 1366, height: 768 } };

// The init scripts below run inside the page, so they use the page's clock.
// Both contexts run on the same machine, so their Date.now() agree.

// Counts alert sounds instead of playing them: window.__alertPlays.
function spyOnSound() {
  window.__alertPlays = 0;
  HTMLMediaElement.prototype.play = function play() {
    window.__alertPlays += 1;
    return Promise.resolve();
  };
}

// Records, in page time, when each send starts: window.__submits.
function timeSubmits() {
  window.__submits = [];
  document.addEventListener('submit', () => window.__submits.push(Date.now()), true);
}

// Records, in page time, when each prescription card first appears:
// window.__arrivals[id].
function timeArrivals() {
  window.__arrivals = {};
  new MutationObserver(() => {
    for (const node of document.querySelectorAll('[data-rx-id]')) {
      const id = node.dataset.rxId;
      if (!(id in window.__arrivals)) window.__arrivals[id] = Date.now();
    }
  }).observe(document, { childList: true, subtree: true });
}

// addInitScript serializes only the function it is given, so combine the
// two as source text rather than calling one from the other.
const pharmacyInit = `(${spyOnSound})(); (${timeArrivals})();`;

async function rolePage(browser, contextOptions, use, initScript) {
  const context = await browser.newContext(contextOptions);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await use(page);
  await context.close();
}

const test = base.test.extend({
  doctor: async ({ browser }, use) => rolePage(browser, DOCTOR_CONTEXT, use, timeSubmits),
  pharmacy: async ({ browser }, use) => rolePage(browser, PHARMACY_CONTEXT, use, pharmacyInit)
});

module.exports = { test, expect: base.expect, DOCTOR_CONTEXT, PHARMACY_CONTEXT };
