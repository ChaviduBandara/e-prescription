---
name: e2e-handoff-test
description: Runs and, if needed, extends the end-to-end tests that simulate the doctor's tablet and the pharmacist's PC at the same time. Use after any change to the server, the doctor screen or the pharmacy screen, or when asked to test the handoff.
---

# End-to-end handoff test

Goal: prove the doctor-to-pharmacist handoff works the way a real clinic session would, with no human clicking.

## How the tests are set up

- Playwright starts the server on a free port with a **temporary database and a temporary archive folder** (see `playwright.config.js` `webServer` and `tests/e2e/fixtures.js`). Never point tests at `data/`.
- Each test opens **two browser contexts**:
  - `doctor`: iPad viewport (1024x1366), touch enabled. Run in both Chromium and WebKit (WebKit stands in for iPad Safari).
  - `pharmacy`: desktop viewport (1366x768).
- Handwriting is simulated with `page.mouse.down()`, several `page.mouse.move()` steps, and `page.mouse.up()` on the canvas.
- The alert sound is checked by spying on `HTMLMediaElement.prototype.play` with `page.addInitScript` and asserting it was called.

## Scenarios that must exist and pass

1. PIN screens block both views until the right PIN is entered.
2. Start session, send a typed prescription, it appears on the pharmacy screen within 1 s with an ID like `RX-YYYYMMDD-0001`, a notice and a sound.
3. Send a handwritten prescription; the pharmacy screen shows an image, not text.
4. Pharmacist taps Dispensed; the doctor screen shows Dispensed within 1 s.
5. Send 5 prescriptions quickly; all arrive, in order, with unique IDs.
6. Doctor goes offline with `context.setOffline(true)` for a few seconds, then online; nothing is lost and the queue resyncs.
7. Restart the server mid-session; both screens reconnect and show the same queue.
8. End session; exactly one PDF appears in the temp archive folder, named `YYYY-MM-DD_session-<id>.pdf`, and its text (read with `pdf-parse`) contains every prescription ID.
9. Typed prescription without a patient ID is rejected with a clear message.

## Steps

1. Run `npm run test:e2e`. If browsers are missing, run `npx playwright install chromium webkit`.
2. If a scenario above has no test yet and the feature exists, write it in `tests/e2e/`.
3. On failure: read the Playwright error, trace and screenshot (`test-results/`), fix the **app code** (not the test) unless the test is wrong, and rerun. Never loosen an assertion or add a long `waitForTimeout` to make a test pass.
4. After the run passes, use the Playwright MCP browser to open both screens yourself, look at the screenshots, and check layout at iPad and desktop sizes.
5. Report: scenarios passed / failed / not yet built, and anything you saw on screen that looks wrong.
