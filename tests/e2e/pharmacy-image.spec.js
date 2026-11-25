// A handwritten prescription is never shown as a blank image on the
// pharmacy screen (CLAUDE.md hard rule 10): it shows a loading message
// until the image has decoded, or an error with Retry. The image route is
// intercepted on the pharmacy page only, to make it slow or fail. The
// route is added after the page has loaded, so only the image sent in the
// test is affected (a held image would also hold up the page's load event,
// and the shared server's queue may already have earlier images).
'use strict';

const { test, expect } = require('./fixtures');
const { fakeRef, openDoctor, openPharmacy, ensureSession, startHandwriting, drawAt, sendAndGetId } = require('./helpers');

const IMAGE_ROUTE = '**/api/prescriptions/*/image*';

// Sends a handwritten prescription from the doctor screen; returns its ID.
async function sendHandwritten(doctor, testInfo) {
  const patientRef = fakeRef(testInfo);
  await startHandwriting(doctor, patientRef);
  await drawAt(doctor, [[100, 100], [300, 120], [500, 100]], { steps: 6 });
  return sendAndGetId(doctor, patientRef);
}

// The image area of a card, and checks that it is showing a decoded image.
function imageView(pharmacy, id) {
  return pharmacy.locator(`[data-rx-id="${id}"] .rx-image-view`);
}

async function expectReady(view) {
  await expect(view).toHaveAttribute('data-image-state', 'ready');
  const img = view.locator('img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((node) => node.complete && node.naturalWidth)).toBeGreaterThan(0);
}

async function open(doctor, pharmacy) {
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
}

test('a slow image shows "Loading prescription image…", then the image once decoded', async ({ doctor, pharmacy }, testInfo) => {
  await open(doctor, pharmacy);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await pharmacy.route(IMAGE_ROUTE, async (route) => {
    await gate;
    await route.continue();
  });
  const id = await sendHandwritten(doctor, testInfo);

  const view = imageView(pharmacy, id);
  await expect(view).toHaveAttribute('data-image-state', 'loading');
  await expect(view).toHaveText('Loading prescription image…');
  await expect(view.locator('img')).toHaveCount(0);
  // Not blank: the loading box takes real space.
  expect((await view.boundingBox()).height).toBeGreaterThanOrEqual(200);

  release();
  await expectReady(view);
  await view.locator('img').click();
  await expect(pharmacy.locator('#viewer')).toBeVisible();
});

test('a failing image shows "Image failed to load", and Retry loads it', async ({ doctor, pharmacy }, testInfo) => {
  await open(doctor, pharmacy);
  let fail = true;
  await pharmacy.route(IMAGE_ROUTE, (route) =>
    fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test"}' }) : route.continue()
  );
  const id = await sendHandwritten(doctor, testInfo);

  const view = imageView(pharmacy, id);
  await expect(view).toHaveAttribute('data-image-state', 'error');
  await expect(view.getByRole('alert')).toHaveText('Image failed to load');
  await expect(view.locator('img')).toHaveCount(0);

  fail = false;
  await view.getByRole('button', { name: 'Retry' }).click();
  await expectReady(view);
});

test('a failed image loads by itself when the connection comes back', async ({ doctor, pharmacy }, testInfo) => {
  // Proxy the pharmacy's Socket.IO connection so the test can drop it, as
  // a WiFi drop or server restart would. (context.setOffline does not
  // close an open localhost WebSocket.) Reconnections pass through.
  const sockets = [];
  await pharmacy.routeWebSocket(/\/socket\.io\//, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await open(doctor, pharmacy);
  let fail = true;
  await pharmacy.route(IMAGE_ROUTE, (route) =>
    fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test"}' }) : route.continue()
  );
  const id = await sendHandwritten(doctor, testInfo);

  const view = imageView(pharmacy, id);
  await expect(view).toHaveAttribute('data-image-state', 'error');

  // The image would load now, but nothing retries it until reconnect.
  fail = false;
  await expect(view).toHaveAttribute('data-image-state', 'error');

  const conn = pharmacy.locator('#conn');
  await Promise.all(sockets.map((ws) => ws.close({ code: 4000, reason: 'test: connection dropped' })));
  await expect(conn).toHaveText('Offline');
  await expect(conn).toHaveText('Connected', { timeout: 15000 });
  await expectReady(view);
});
