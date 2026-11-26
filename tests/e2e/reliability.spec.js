// Phase 7: scenario 6 (the tablet goes offline for a few seconds), a lost
// ack, and scenario 7 (the server restarts mid-session).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, DOCTOR_CONTEXT, PHARMACY_CONTEXT, PINS } = require('./fixtures');
const {
  exposeSocket,
  fakeRef,
  fillLine,
  openDoctor,
  openPharmacy,
  ensureSession,
  sendTyped,
  startHandwriting,
  drawStroke,
  sendAndGetId
} = require('./helpers');
const { spawnServer, killServer } = require('../server-process');

const SENT_RE = (ref) => new RegExp(`^Sent RX-\\d{8}-\\d{4,} \\(${ref}\\)$`);

// Fills a typed prescription and taps Send, without waiting for the reply.
async function fillAndTapSend(doctor, patientRef) {
  await doctor.getByLabel('Patient ID or token').fill(patientRef);
  await fillLine(doctor, 1, { medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily' });
  await doctor.getByRole('button', { name: 'Send' }).tap();
}

// Every card on the pharmacy screen: [id, status] in screen order.
const pharmacyCards = (pharmacy) =>
  pharmacy.locator('#queue > li, #dispensed-list > li').evaluateAll((nodes) =>
    nodes.map((n) => [n.dataset.rxId, n.querySelector('.badge').textContent])
  );
const doctorItems = (doctor) =>
  doctor.locator('#sent-list > li').evaluateAll((nodes) => nodes.map((n) => [n.dataset.rxId, n.querySelector('.badge').textContent]));

test('scenario 6: the tablet is offline for a few seconds; nothing is lost and both screens resync', async ({
  doctor,
  pharmacy
}, testInfo) => {
  test.setTimeout(60_000);
  const base = fakeRef(testInfo);
  const webkit = testInfo.project.name === 'webkit';
  await doctor.addInitScript(exposeSocket);
  // WebKit's offline mode blocks HTTP but not WebSockets (open or new), so
  // there the test also refuses the tablet's socket while "offline".
  let wifiDown = false;
  if (webkit) {
    await doctor.routeWebSocket(/\/socket\.io\//, (ws) => (wifiDown ? ws.close() : ws.connectToServer()));
  }
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  const first = await sendTyped(doctor, `${base}-1`);
  await expect(pharmacy.locator(`[data-rx-id="${first}"]`)).toBeVisible();
  await pharmacy.locator('#notice').click();

  await doctor.context().setOffline(true);
  wifiDown = true;
  if (webkit) {
    // Drop the open socket the way the heartbeat does on a real WiFi loss.
    await doctor.evaluate(() => window.__socket.io.engine.close());
  }
  // Chromium's offline mode silences the socket like a real WiFi loss: the
  // send goes into a dead connection and the heartbeat has to notice.
  await fillAndTapSend(doctor, `${base}-2`);
  await expect(doctor.locator('#conn')).toHaveText('Reconnecting…', { timeout: 20_000 });
  await expect(doctor.locator('#offline-banner')).toBeVisible();
  const status = doctor.locator('#send-status');
  await expect(status).toHaveText(/^NOT sent yet: no connection/);

  // While the tablet is away the pharmacist dispenses the first one.
  await pharmacy.locator(`[data-rx-id="${first}"]`).getByRole('button', { name: 'Dispensed' }).click();
  await expect(pharmacy.locator(`#dispensed-list [data-rx-id="${first}"]`)).toBeVisible();
  await expect(doctor.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue(`${base}-2`); // kept, locked
  await doctor.waitForTimeout(3000); // "a few seconds" offline is the scenario itself
  await expect(pharmacy.getByText(`${base}-2`)).toHaveCount(0);

  wifiDown = false;
  await doctor.context().setOffline(false);
  await expect(doctor.locator('#conn')).toHaveText('Connected', { timeout: 15_000 });
  await expect(status).toHaveText(SENT_RE(`${base}-2`));
  const second = (await status.textContent()).match(/RX-\d{8}-\d{4,}/)[0];

  // The doctor's list caught up with the dispense it missed...
  await expect(doctor.locator(`[data-rx-id="${first}"] .badge`)).toHaveText('Dispensed');
  await expect(doctor.locator(`[data-rx-id="${second}"] .badge`)).toHaveText('Sent');
  // ...and the pharmacy got the waiting prescription exactly once.
  await expect(pharmacy.locator(`#queue [data-rx-id="${second}"]`)).toBeVisible();
  await expect(pharmacy.locator('.rx-card__patient', { hasText: `${base}-2` })).toHaveCount(1);
  await expect(pharmacy.locator('#notice-text')).toContainText(second);
  // Both screens agree on the whole session.
  const pharmacyIds = (await pharmacyCards(pharmacy)).map(([id]) => id).sort();
  expect((await doctorItems(doctor)).map(([id]) => id).sort()).toEqual(pharmacyIds);
});

test('a send whose reply is lost is retried with the same request ID and saved once', async ({ doctor, pharmacy }, testInfo) => {
  const patientRef = fakeRef(testInfo);
  await doctor.addInitScript(exposeSocket);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  // The next send reaches the server, but its reply is thrown away and the
  // page is told it timed out: exactly what a WiFi drop right after
  // sending looks like.
  await doctor.evaluate(() => {
    const socket = window.__socket;
    const timeout = socket.timeout;
    let dropped = false;
    socket.timeout = function dropFirstReply(ms) {
      if (dropped) return timeout.call(this, ms);
      dropped = true;
      return {
        emit: (event, payload, callback) => {
          socket.emit(event, payload, () => {}); // saved; reply lost
          setTimeout(() => callback(new Error('operation has timed out')), 500);
        }
      };
    };
  });
  await fillAndTapSend(doctor, patientRef);
  const status = doctor.locator('#send-status');
  await expect(status).toHaveText(/^No reply from the pharmacy PC yet/);
  await expect(status).toHaveText(SENT_RE(patientRef), { timeout: 10_000 });

  await expect(pharmacy.locator('.rx-card__patient', { hasText: patientRef })).toHaveCount(1);
  await expect(doctor.locator('.patient', { hasText: patientRef })).toHaveCount(1);
  // The pharmacy was alerted once, not twice.
  await expect(pharmacy.locator('#notice-text')).toHaveText(new RegExp(`^New prescription RX-\\d{8}-\\d{4,} for ${patientRef}$`));
});

test('scenario 7: the server restarts mid-session; both screens reconnect and show the same queue', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-prescription-restart-'));
  const dirs = { dataDir: path.join(root, 'data'), archiveDir: path.join(root, 'archive'), pins: PINS };
  let server = await spawnServer(dirs);
  const contexts = [];
  try {
    const open = async (options, role, url) => {
      const context = await browser.newContext({ ...options, baseURL: server.base });
      contexts.push(context);
      const page = await context.newPage();
      expect((await page.request.post('/api/auth/login', { data: { role, pin: PINS[role] } })).status()).toBe(200);
      await page.goto(url);
      await expect(page.locator('#conn')).toHaveText('Connected');
      return page;
    };
    const pharmacy = await open(PHARMACY_CONTEXT, 'pharmacy', '/pharmacy/');
    await pharmacy.getByRole('button', { name: 'Start receiving' }).click();
    const doctor = await open(DOCTOR_CONTEXT, 'doctor', '/doctor/');
    await ensureSession(doctor);
    const sessionLabel = await doctor.locator('#session-label').textContent();

    const ref = fakeRef(testInfo);
    const typed = await sendTyped(doctor, `${ref}-1`);
    await startHandwriting(doctor, `${ref}-2`);
    await drawStroke(doctor, [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]]);
    const drawn = await sendAndGetId(doctor, `${ref}-2`);
    await expect(pharmacy.locator(`[data-rx-id="${drawn}"] img`)).toBeVisible();
    await pharmacy.locator(`[data-rx-id="${typed}"]`).getByRole('button', { name: 'Dispensed' }).click();
    await expect(doctor.locator(`[data-rx-id="${typed}"] .badge`)).toHaveText('Dispensed');
    await pharmacy.locator('#notice').click();
    const queueBefore = await pharmacyCards(pharmacy);
    const listBefore = await doctorItems(doctor);

    // The server dies (no shutdown code runs).
    await killServer(server.child);
    await expect(doctor.locator('#conn')).toHaveText('Reconnecting…');
    await expect(pharmacy.locator('#conn')).toHaveText('Reconnecting…');
    // The doctor sends while it is down: it waits on the tablet.
    await doctor.getByRole('radio', { name: 'Typed' }).tap();
    await fillAndTapSend(doctor, `${ref}-3`);
    await expect(doctor.locator('#send-status')).toHaveText(/^NOT sent yet/);

    // Back on the same port with the same data.
    server = await spawnServer({ ...dirs, port: server.port });
    await expect(doctor.locator('#conn')).toHaveText('Connected', { timeout: 15_000 });
    await expect(pharmacy.locator('#conn')).toHaveText('Connected', { timeout: 15_000 });
    await expect(doctor.locator('#send-status')).toHaveText(SENT_RE(`${ref}-3`));
    const third = (await doctor.locator('#send-status').textContent()).match(/RX-\d{8}-\d{4,}/)[0];

    // Same session and the same queue, plus the one sent during the outage.
    await expect(doctor.locator('#session-label')).toHaveText(sessionLabel);
    await expect(pharmacy.locator(`#queue [data-rx-id="${third}"]`)).toBeVisible();
    await expect(pharmacy.locator('.rx-card__patient', { hasText: `${ref}-3` })).toHaveCount(1);
    expect(await pharmacyCards(pharmacy)).toEqual([...queueBefore.filter(([, s]) => s === 'Waiting'), [third, 'Waiting'], ...queueBefore.filter(([, s]) => s !== 'Waiting')]);
    expect(await doctorItems(doctor)).toEqual([[third, 'Sent'], ...listBefore]);
    // The handwriting still shows as the image.
    await expect(pharmacy.locator(`[data-rx-id="${drawn}"] img`)).toBeVisible();
    expect(await pharmacy.locator(`[data-rx-id="${drawn}"] img`).evaluate((img) => img.naturalWidth > 0)).toBe(true);
    await expect(pharmacy.locator('#notice-text')).toContainText(third);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await killServer(server.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
