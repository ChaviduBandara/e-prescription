// Scenario 8 from the e2e-handoff-test skill: End Session writes exactly one
// dated PDF to the (temp) archive folder, containing every prescription ID.
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { test, expect } = require('./fixtures');
const {
  fakeRef,
  openDoctor,
  openPharmacy,
  ensureSession,
  sendTyped,
  startHandwriting,
  drawStroke,
  sendAndGetId
} = require('./helpers');

const ARCHIVE_DIR = process.env.E2E_ARCHIVE_DIR;

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('scenario 8: End Session writes one PDF named YYYY-MM-DD_session-<id>.pdf with every prescription ID', async ({
  doctor,
  pharmacy
}, testInfo) => {
  const base = fakeRef(testInfo);
  await openPharmacy(pharmacy);
  await openDoctor(doctor);
  await ensureSession(doctor);
  const sessionId = (await doctor.locator('#session-label').textContent()).match(/Session (\d+)/)[1];
  const sessionStartedOn = localDate(); // started by this or an earlier test today

  const ids = [];
  ids.push(await sendTyped(doctor, `${base}-1`));
  ids.push(await sendTyped(doctor, `${base}-2`, 'Test Syrup 5ml'));
  await startHandwriting(doctor, `${base}-3`);
  await drawStroke(doctor, [[0.1, 0.2], [0.3, 0.25], [0.5, 0.2]]);
  ids.push(await sendAndGetId(doctor, `${base}-3`));
  await expect(pharmacy.locator(`[data-rx-id="${ids[2]}"]`)).toBeVisible();
  // Every ID in this session, including any from earlier tests.
  const allIds = await pharmacy
    .locator('#queue > li, #dispensed-list > li')
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.rxId));
  expect(allIds).toEqual(expect.arrayContaining(ids));

  await pharmacy.locator('#notice').click();
  await pharmacy.getByRole('button', { name: 'End Session' }).click();
  await pharmacy.getByRole('dialog').getByRole('button', { name: 'End Session' }).click();

  const name = `${sessionStartedOn}_session-${sessionId}.pdf`;
  await expect(pharmacy.locator('#ended-note')).toHaveText(new RegExp(`Archived as ${name.replace(/\./g, '\\.')}\\.$`));
  await expect(pharmacy.locator('#archive-warning')).toBeHidden();

  // Exactly one file for this session, and no half-written temp file.
  const files = fs.readdirSync(ARCHIVE_DIR);
  expect(files.filter((f) => f.includes(`_session-${sessionId}`))).toEqual([name]);
  expect(files.filter((f) => f.endsWith('.partial'))).toEqual([]);

  const parser = new PDFParse({ data: fs.readFileSync(path.join(ARCHIVE_DIR, name)) });
  try {
    const { text } = await parser.getText();
    for (const id of allIds) expect(text, id).toContain(id);
    expect(text).toContain(`${base}-3`);
    const { pages } = await parser.getImage();
    expect(pages.flatMap((p) => p.images).length).toBeGreaterThanOrEqual(1);
  } finally {
    await parser.destroy();
  }
});

test('the pharmacy shows the archive warning until the PDF is saved', async ({ pharmacy }) => {
  // The server's retry is covered by the integration tests; here the status
  // reply is faked so the shared test server's archive folder stays usable.
  await pharmacy.route('**/api/archive/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        failing: [{ sessionId: 41, error: 'the archive folder cannot be found', attempts: 3, nextRetryAt: new Date().toISOString() }]
      })
    })
  );
  await openPharmacy(pharmacy);
  const warning = pharmacy.locator('#archive-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('The PDF archive for session 41 could not be saved: the archive folder cannot be found.');
  await expect(warning).toContainText('Retrying automatically');
  await expect(warning).toContainText('The prescriptions are safe in the database.');

  // A status with nothing failing (as broadcast after a successful retry) clears it.
  await pharmacy.unroute('**/api/archive/status');
  await pharmacy.reload();
  await pharmacy.getByRole('button', { name: 'Start receiving' }).click();
  await expect(warning).toBeHidden();
});
