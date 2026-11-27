// Phase 7b: a send that waits on the tablet (no connection, no reply).
// - If its session ends before it arrives, it is refused and stays filled
//   in, to send again in the next session.
// - If the page is reloaded while it waits, it is put back and sent once.
'use strict';

const { test, expect } = require('./fixtures');
const { exposeSocket, fakeRef, fillLine, openDoctor, openPharmacy, ensureSession, startHandwriting, drawStroke } = require('./helpers');

const SESSION_ENDED = 'The session ended before this was sent. Start a new session and send again.';
const SENT_RE = (ref) => new RegExp(`^Sent RX-\\d{8}-\\d{4,} \\(${ref}\\)$`);
const WAITING_KEY = 'rx-pending-send';

async function fillTyped(doctor, patientRef) {
  await doctor.getByLabel('Patient ID or token').fill(patientRef);
  await fillLine(doctor, 1, { medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily' });
}

async function endSessionFromPharmacy(pharmacy) {
  await pharmacy.getByRole('button', { name: 'End Session' }).click();
  await pharmacy.getByRole('dialog').getByRole('button', { name: 'End Session' }).click();
  await expect(pharmacy.locator('#ended-note')).toBeVisible();
}

// The tablet's WiFi, as a switch: while down, its Socket.IO connection is
// dropped and every reconnect is refused. Plain HTTP (page loads) still
// works, as when the tablet reloads from its cache. Works the same way in
// Chromium and WebKit.
async function wifiSwitch(doctor) {
  const state = { down: false };
  await doctor.routeWebSocket(/\/socket\.io\//, (ws) => (state.down ? ws.close() : ws.connectToServer()));
  return {
    async down() {
      state.down = true;
      await doctor.evaluate(() => window.__socket.io.engine.close());
      await expect(doctor.locator('#conn')).toHaveText('Reconnecting…');
    },
    up() {
      state.down = false;
    }
  };
}

const stored = (doctor) => doctor.evaluate((key) => sessionStorage.getItem(key), WAITING_KEY);

test('a send held up until its session has ended is refused and stays filled in for the next session', async ({ doctor, pharmacy }, testInfo) => {
  const ref = fakeRef(testInfo);
  await doctor.addInitScript(exposeSocket);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  // The next prescription:new is held on the tablet (like a slow network)
  // until the test lets it go. Other events pass through.
  await doctor.evaluate(() => {
    const socket = window.__socket;
    const timeout = socket.timeout;
    let held = false;
    socket.timeout = function holdFirstSend(ms) {
      const real = timeout.call(this, ms);
      return {
        emit(event, payload, callback) {
          if (event !== 'prescription:new' || held) return real.emit(event, payload, callback);
          held = true;
          window.__release = () => real.emit(event, payload, callback);
        }
      };
    };
  });
  await fillTyped(doctor, ref);
  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(doctor.getByRole('button', { name: 'Sending…' })).toBeDisabled();

  // The pharmacist ends the session while the send is still on its way.
  await endSessionFromPharmacy(pharmacy);
  await expect(doctor.locator('#no-session')).toBeVisible();
  await doctor.evaluate(() => window.__release());

  const note = doctor.locator('#unsent-note');
  await expect(note).toHaveText(SESSION_ENDED);
  await expect(note).toBeVisible();
  await expect(pharmacy.getByText(ref)).toHaveCount(0);

  // New session: the prescription is still there, ready to send again.
  await doctor.getByRole('button', { name: 'Start Session' }).tap();
  await expect(doctor.locator('#session')).toBeVisible();
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue(ref);
  await expect(doctor.getByLabel('Medicine, line 1')).toHaveValue('Test Medicine 10mg');
  await expect(doctor.getByLabel('Instructions, line 1')).toHaveValue('Twice daily');
  await expect(doctor.locator('#send-status')).toHaveText(SESSION_ENDED);
  expect(await stored(doctor)).toBeNull();

  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(doctor.locator('#send-status')).toHaveText(SENT_RE(ref));
  await expect(pharmacy.locator('#queue .rx-card__patient', { hasText: ref })).toHaveCount(1);
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue('');
});

test('a typed send waiting offline survives a reload and is sent once', async ({ doctor, pharmacy }, testInfo) => {
  test.setTimeout(60_000);
  const ref = fakeRef(testInfo);
  await doctor.addInitScript(exposeSocket);
  const wifi = await wifiSwitch(doctor);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  await wifi.down();
  await fillTyped(doctor, ref);
  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(doctor.locator('#send-status')).toHaveText(/^NOT sent yet/);
  const kept = JSON.parse(await stored(doctor));
  expect(kept.payload).toMatchObject({ patientRef: ref, kind: 'typed' });
  expect(kept.payload.requestId).toMatch(/^[0-9a-f]{32}$/);

  // Reloaded while still offline: the page cannot load the session yet,
  // but the send is still kept.
  await doctor.reload();
  await expect(doctor.locator('#conn')).not.toHaveText('Connected');
  expect(JSON.parse(await stored(doctor))).toEqual(kept);
  await doctor.waitForTimeout(1000);
  await expect(pharmacy.getByText(ref)).toHaveCount(0);

  wifi.up();
  await expect(doctor.locator('#send-status')).toHaveText(SENT_RE(ref), { timeout: 20_000 });
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue('');
  expect(await stored(doctor)).toBeNull();
  await expect(pharmacy.locator('.rx-card__patient', { hasText: ref })).toHaveCount(1);
  await expect(doctor.locator('.patient', { hasText: ref })).toHaveCount(1);
});

// For addInitScript: like exposeSocket, and while sessionStorage has
// "test-hold-sends" every prescription:new is held on the tablet (a send
// with no reply yet) until window.__release() lets it go. Survives reloads.
function holdSends() {
  let realIo;
  Object.defineProperty(window, 'io', {
    configurable: true,
    get: () =>
      realIo &&
      ((...args) => {
        const socket = realIo(...args);
        window.__socket = socket;
        const timeout = socket.timeout;
        socket.timeout = function maybeHold(ms) {
          const real = timeout.call(this, ms);
          return {
            emit(event, payload, callback) {
              if (event !== 'prescription:new' || !sessionStorage.getItem('test-hold-sends')) return real.emit(event, payload, callback);
              window.__release = () => {
                sessionStorage.removeItem('test-hold-sends');
                real.emit(event, payload, callback);
              };
            }
          };
        };
        return socket;
      }),
    set: (value) => (realIo = value)
  });
}

test('a handwritten send still waiting survives a reload: the same drawing is shown and the same PNG arrives once', async ({
  doctor,
  pharmacy
}, testInfo) => {
  const ref = fakeRef(testInfo);
  await doctor.addInitScript(holdSends);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  await startHandwriting(doctor, ref);
  await drawStroke(doctor, [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]]);
  const canvasBefore = await doctor.locator('#pad').evaluate((c) => c.toDataURL('image/png'));
  await doctor.evaluate(() => sessionStorage.setItem('test-hold-sends', '1'));
  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(doctor.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  const kept = JSON.parse(await stored(doctor));
  expect(kept.payload).toMatchObject({ patientRef: ref, kind: 'handwritten' });

  await doctor.reload();
  await expect(doctor.locator('#session')).toBeVisible();
  await expect(doctor.getByLabel('Patient ID or token')).toHaveValue(ref);
  await expect(doctor.locator('input[name=mode][value=handwritten]')).toBeChecked();
  await expect(doctor.getByRole('button', { name: 'Sending…' })).toBeDisabled(); // locked while it waits
  await expect(doctor.locator('.pad')).toHaveClass(/pad--drawn/);
  await expect(doctor.locator('#pad-locked')).toBeHidden();
  // The same strokes at the same place and size. Replaying strokes can
  // shade a few edge pixels differently (anti-aliasing); what is sent is the
  // kept PNG itself, checked byte for byte below.
  const diff = await doctor.locator('#pad').evaluate(async (canvas, before) => {
    const img = new Image();
    img.src = before;
    await img.decode();
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(img, 0, 0);
    const a = copy.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const b = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0;
    let ink = 0;
    for (let i = 3; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8) changed++;
      if (a[i] > 128) ink++;
    }
    return { changed, ink, sameSize: img.width === canvas.width && img.height === canvas.height };
  }, canvasBefore);
  expect(diff.sameSize).toBe(true);
  expect(diff.ink).toBeGreaterThan(500);
  expect(diff.changed).toBeLessThan(diff.ink * 0.02);
  await expect(pharmacy.getByText(ref)).toHaveCount(0);

  await doctor.evaluate(() => window.__release());
  await expect(doctor.locator('#send-status')).toHaveText(SENT_RE(ref));
  expect(await stored(doctor)).toBeNull();
  const id = (await doctor.locator('#send-status').textContent()).match(/RX-\d{8}-\d{4,}/)[0];
  await expect(pharmacy.locator('.rx-card__patient', { hasText: ref })).toHaveCount(1);
  await expect(pharmacy.locator(`[data-rx-id="${id}"] img`)).toBeVisible();
  // The PNG saved is exactly the one kept before the reload.
  const image = await pharmacy.request.get(`/api/prescriptions/${id}/image`);
  expect((await image.body()).toString('base64')).toBe(kept.payload.image);
});

test('if the tablet cannot keep a waiting send, it says so, and the send still goes once', async ({ doctor, pharmacy }, testInfo) => {
  test.setTimeout(60_000);
  const ref = fakeRef(testInfo);
  await doctor.addInitScript(exposeSocket);
  await doctor.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  const wifi = await wifiSwitch(doctor);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  await wifi.down();
  await fillTyped(doctor, ref);
  await doctor.getByRole('button', { name: 'Send' }).tap();
  await expect(doctor.locator('#send-status')).toHaveText(/^NOT sent yet.* This waiting send will be lost if the page is reloaded\.$/);
  wifi.up();
  await expect(doctor.locator('#send-status')).toHaveText(SENT_RE(ref), { timeout: 20_000 });
  await expect(pharmacy.locator('.rx-card__patient', { hasText: ref })).toHaveCount(1);
});
