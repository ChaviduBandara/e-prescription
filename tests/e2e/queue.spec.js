// Phase 4 queue features: Start receiving, the notice, Dispensed (scenario
// 4), a burst of sends (scenario 5) and End Session.
'use strict';

const { test, expect } = require('./fixtures');
const { login, fakeRef, openDoctor, openPharmacy, ensureSession, sendTyped } = require('./helpers');

const ID_RE = /^RX-\d{8}-\d{4,}$/;

test('the pharmacy queue stays hidden until Start receiving is tapped', async ({ doctor, pharmacy }, testInfo) => {
  await openDoctor(doctor);
  await ensureSession(doctor);
  await login(pharmacy, 'pharmacy');
  await pharmacy.goto('/pharmacy/');
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');
  const start = pharmacy.getByRole('button', { name: 'Start receiving' });
  await expect(start).toBeVisible();
  await expect(pharmacy.locator('#queue-section')).toBeHidden();
  await expect(pharmacy.getByRole('button', { name: 'End Session' })).toBeHidden();

  // A prescription that arrives before the tap: no sound, no notice; it is
  // in the queue once receiving starts.
  const id = await sendTyped(doctor, fakeRef(testInfo));
  await expect(pharmacy.locator('#notice')).toBeHidden();
  expect(await pharmacy.evaluate(() => window.__alertPlays)).toBe(0);

  await start.click();
  await expect(start).toBeHidden();
  await expect(pharmacy.locator(`#queue [data-rx-id="${id}"]`)).toBeVisible();
  await expect(pharmacy.getByRole('button', { name: 'End Session' })).toBeVisible();
});

test('the new-prescription notice stays until clicked and counts what arrived', async ({ doctor, pharmacy }, testInfo) => {
  await pharmacy.clock.install();
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);

  const first = fakeRef(testInfo);
  await sendTyped(doctor, first);
  const notice = pharmacy.locator('#notice');
  await expect(notice).toContainText(first);
  // Well past any auto-hide (and the card highlight), still showing.
  await pharmacy.clock.fastForward('00:20');
  await expect(notice).toBeVisible();

  const second = `${first}-B`;
  const secondId = await sendTyped(doctor, second);
  await expect(pharmacy.locator('#notice-text')).toHaveText(new RegExp(`^2 new prescriptions\\. Latest: ${secondId} for ${second}`));

  await pharmacy.getByRole('button', { name: 'OK' }).click();
  await expect(notice).toBeHidden();
});

test('scenario 4: Dispensed moves the card and the doctor sees it within 1 s', async ({ doctor, pharmacy }, testInfo) => {
  const patientRef = fakeRef(testInfo);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  const id = await sendTyped(doctor, patientRef);

  const card = pharmacy.locator(`#queue [data-rx-id="${id}"]`);
  await expect(card.locator('.badge')).toHaveText('Waiting');
  const doctorBadge = doctor.locator(`#sent-list [data-rx-id="${id}"] .badge`);
  await expect(doctorBadge).toHaveText('Sent');

  await pharmacy.locator('#notice').click(); // dismiss, as the pharmacist would

  // Timed inside the browsers (same machine, same clock), so Playwright's
  // own overhead is not counted: the tap on the pharmacy, and the moment
  // the doctor's badge changes.
  await pharmacy.evaluate(() =>
    document.addEventListener('click', () => (window.__tappedAt = Date.now()), { capture: true, once: true })
  );
  await doctor.evaluate((rxId) => {
    new MutationObserver((_, observer) => {
      const badge = document.querySelector(`#sent-list [data-rx-id="${rxId}"] .badge`);
      if (badge && badge.textContent === 'Dispensed') {
        window.__dispensedShownAt = Date.now();
        observer.disconnect();
      }
    }).observe(document.getElementById('sent-list'), { childList: true, subtree: true, characterData: true });
  }, id);
  await card.getByRole('button', { name: 'Dispensed' }).click();
  await expect(doctorBadge).toHaveText('Dispensed');
  const elapsed =
    (await doctor.evaluate(() => window.__dispensedShownAt)) - (await pharmacy.evaluate(() => window.__tappedAt));
  console.log(`[${testInfo.project.name}] dispensed-to-doctor: ${elapsed} ms`);
  expect(elapsed).toBeLessThan(1000);

  // The card left the waiting queue for the Dispensed section.
  await expect(card).toHaveCount(0);
  const done = pharmacy.locator(`#dispensed-list [data-rx-id="${id}"]`);
  await expect(done).toBeVisible();
  await expect(done.locator('.badge')).toHaveText('Dispensed');
  await expect(done).toContainText(/Dispensed at \d/);
  await expect(done.getByRole('button', { name: 'Dispensed' })).toHaveCount(0);

  // Both screens keep it after a reload.
  await pharmacy.reload();
  await pharmacy.getByRole('button', { name: 'Start receiving' }).click();
  await expect(pharmacy.locator(`#dispensed-list [data-rx-id="${id}"]`)).toBeVisible();
  await doctor.reload();
  await expect(doctor.locator(`#sent-list [data-rx-id="${id}"] .badge`)).toHaveText('Dispensed');
});

test('scenario 5: five quick sends all arrive, in order, with unique IDs', async ({ doctor, pharmacy }, testInfo) => {
  const base = fakeRef(testInfo);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  const playsBefore = await pharmacy.evaluate(() => window.__alertPlays);

  const refs = [1, 2, 3, 4, 5].map((n) => `${base}-${n}`);
  const ids = [];
  for (const ref of refs) ids.push(await sendTyped(doctor, ref, `Test Medicine ${ids.length + 1}0mg`));

  expect(new Set(ids).size).toBe(5);
  ids.forEach((id) => expect(id).toMatch(ID_RE));
  // Running numbers go up in send order.
  const numbers = ids.map((id) => Number(id.split('-')[2]));
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));

  // The pharmacy shows all five as the last five cards, in send order.
  const cards = pharmacy.locator('#queue > li');
  await expect(pharmacy.locator('#queue > li', { hasText: base })).toHaveCount(5);
  const shown = await cards.evaluateAll((nodes) => nodes.map((n) => n.dataset.rxId));
  expect(shown.slice(-5)).toEqual(ids);
  for (const [i, ref] of refs.entries()) {
    await expect(pharmacy.locator(`[data-rx-id="${ids[i]}"]`)).toContainText(ref);
  }
  // One sound per prescription, and one notice counting them.
  await expect.poll(() => pharmacy.evaluate(() => window.__alertPlays)).toBe(playsBefore + 5);
  await expect(pharmacy.locator('#notice')).toContainText('5 new prescriptions');
  await expect(doctor.locator('#sent-list > li', { hasText: base })).toHaveCount(5);
});

test('End Session asks first, then returns both screens to their start state', async ({ doctor, pharmacy }, testInfo) => {
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  const sessionText = await doctor.locator('#session-label').textContent();
  const sessionId = sessionText.match(/Session (\d+)/)[1];
  const id = await sendTyped(doctor, fakeRef(testInfo));
  await expect(pharmacy.locator(`[data-rx-id="${id}"]`)).toBeVisible();
  await pharmacy.locator('#notice').click();

  // Cancel keeps the session open.
  const dialog = pharmacy.getByRole('dialog', { name: 'End this session?' });
  await pharmacy.getByRole('button', { name: 'End Session' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Session ${sessionId}:`);
  await expect(dialog).toContainText(/not marked Dispensed yet/);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(pharmacy.locator('#queue-section')).toBeVisible();

  // Confirm ends it.
  await pharmacy.getByRole('button', { name: 'End Session' }).click();
  await dialog.getByRole('button', { name: 'End Session' }).click();
  await expect(dialog).toBeHidden();

  await expect(pharmacy.locator('#no-session')).toBeVisible();
  await expect(pharmacy.locator('#queue-section')).toBeHidden();
  await expect(pharmacy.locator('#ended-note')).toContainText(`Session ${sessionId} ended`);
  await expect(pharmacy.getByRole('button', { name: 'End Session' })).toBeHidden();
  await expect(pharmacy.locator('#session-label')).toHaveText('');

  await expect(doctor.getByRole('button', { name: 'Start Session' })).toBeVisible();
  await expect(doctor.locator('#session')).toBeHidden();
  await expect(doctor.locator('#ended-note')).toContainText(`ended session ${sessionId}`);

  // The doctor can start the next session; the pharmacy follows with an empty queue.
  await doctor.getByRole('button', { name: 'Start Session' }).tap();
  await expect(doctor.locator('#session-label')).not.toHaveText(sessionText);
  await expect(doctor.locator('#sent-empty')).toBeVisible();
  await expect(pharmacy.locator('#queue-section')).toBeVisible();
  await expect(pharmacy.locator('#queue > li')).toHaveCount(0);
  await expect(pharmacy.locator('#ended-note')).toBeHidden();
});
