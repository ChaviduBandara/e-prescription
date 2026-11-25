// A handwritten prescription is never shown as a blank image on the
// pharmacy screen: loading and error states cover the time until the PNG
// has decoded (public/pharmacy/image-view.js).
'use strict';

const { test, expect } = require('./fixtures');
const { fakeRef, openDoctor, openPharmacy, ensureSession, startHandwriting, drawStroke, sendAndGetId } = require('./helpers');

const IMAGE_ROUTE = '**/api/prescriptions/*/image*';

// Keeps the page's Socket.IO client on window.__socket so a test can drop
// the connection. Runs before /vendor/socket.io.min.js defines window.io.
function exposeSocket() {
  let realIo;
  Object.defineProperty(window, 'io', {
    configurable: true,
    get: () =>
      realIo &&
      ((...args) => {
        window.__socket = realIo(...args);
        return window.__socket;
      }),
    set: (value) => (realIo = value)
  });
}

// Sends one handwritten prescription from the doctor and returns its ID.
async function sendHandwritten(doctor, testInfo) {
  const patientRef = fakeRef(testInfo);
  await openDoctor(doctor);
  await ensureSession(doctor);
  await startHandwriting(doctor, patientRef);
  await drawStroke(doctor, [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]]);
  return sendAndGetId(doctor, patientRef);
}

async function expectReady(card) {
  const img = card.locator('img');
  await expect(card.locator('.rx-image-view')).toHaveAttribute('data-state', 'ready');
  await expect(img).toBeVisible();
  expect(await img.evaluate((node) => node.complete && node.naturalWidth)).toBeGreaterThan(0);
  await expect(card.locator('.rx-image-state')).toHaveCount(0);
}

test('a slow image shows "Loading prescription image…" until it has decoded', async ({ doctor, pharmacy }, testInfo) => {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  // Hold only images asked for after the screen is open: earlier tests'
  // prescriptions in the shared session must not block the page load.
  let hold = false;
  await pharmacy.route(IMAGE_ROUTE, async (route) => {
    if (hold) await released;
    await route.continue();
  });
  await openPharmacy(pharmacy);
  hold = true;
  const id = await sendHandwritten(doctor, testInfo);

  const card = pharmacy.locator(`[data-rx-id="${id}"]`);
  await expect(card.locator('.rx-image-view')).toHaveAttribute('data-state', 'loading');
  await expect(card.getByText('Loading prescription image…')).toBeVisible();
  // No <img> on the card at all while loading: nothing that could look blank.
  await expect(card.locator('img')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Retry' })).toBeHidden();

  release();
  await expectReady(card);
});

test('a failing image shows "Image failed to load" and Retry loads it', async ({ doctor, pharmacy }, testInfo) => {
  let fail = true;
  let requests = 0;
  await pharmacy.route(IMAGE_ROUTE, (route) => {
    requests += 1;
    return fail ? route.fulfill({ status: 500, body: 'test failure' }) : route.continue();
  });
  await openPharmacy(pharmacy);
  const id = await sendHandwritten(doctor, testInfo);

  const card = pharmacy.locator(`[data-rx-id="${id}"]`);
  await expect(card.locator('.rx-image-view')).toHaveAttribute('data-state', 'error');
  await expect(card.getByText('Image failed to load')).toBeVisible();
  await expect(card.locator('img')).toHaveCount(0);
  const retry = card.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();

  // Still failing: Retry tries again and stays in the error state.
  const before = requests;
  await retry.click();
  await expect.poll(() => requests).toBeGreaterThan(before);
  await expect(card.locator('.rx-image-view')).toHaveAttribute('data-state', 'error');

  fail = false;
  await retry.click();
  await expectReady(card);

  // The ready image opens full screen as before.
  await card.locator('img').click();
  await expect(pharmacy.locator('#viewer')).toBeVisible();
  await expect.poll(() => pharmacy.locator('#viewer img').evaluate((n) => n.complete && n.naturalWidth)).toBeGreaterThan(0);
});

test('a failed image retries by itself when the connection comes back', async ({ doctor, pharmacy }, testInfo) => {
  let fail = true;
  await pharmacy.addInitScript(exposeSocket);
  await pharmacy.route(IMAGE_ROUTE, (route) =>
    fail ? route.fulfill({ status: 500, body: 'test failure' }) : route.continue()
  );
  await openPharmacy(pharmacy);
  const id = await sendHandwritten(doctor, testInfo);

  const card = pharmacy.locator(`[data-rx-id="${id}"]`);
  await expect(card.getByText('Image failed to load')).toBeVisible();

  fail = false;
  // Drop the transport; Socket.IO reconnects on its own.
  await pharmacy.evaluate(() => window.__socket.io.engine.close());
  await expect(pharmacy.locator('#conn')).toHaveText('Offline');
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');
  await expectReady(card);
});
