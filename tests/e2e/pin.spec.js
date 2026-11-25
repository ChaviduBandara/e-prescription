// Scenario 1 from the e2e-handoff-test skill: PIN screens block both views
// until the right PIN is entered.
'use strict';

const { test, expect, PINS } = require('./fixtures');
const { exposeSocket } = require('./helpers');

async function expectLocked(page, title) {
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByLabel('Enter PIN')).toBeVisible();
  await expect(page.getByLabel('Enter PIN')).toBeFocused();
  // Nothing else on the page shows, and no data is reachable.
  await expect(page.locator('header.topbar')).toBeHidden();
  await expect(page.locator('body > main:not(.pin-screen)')).toBeHidden();
}

// No login cookie at all: the API refuses to give out data.
async function expectNoData(page) {
  const status = await page.evaluate(async () => (await fetch('/api/session/current')).status);
  expect(status).toBe(401);
}

async function enterPin(page, pin) {
  await page.getByLabel('Enter PIN').fill(pin);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('scenario 1: the doctor screen is blocked until the doctor PIN is entered', async ({ doctor }) => {
  await doctor.goto('/doctor/');
  await expectLocked(doctor, 'Doctor');
  await expectNoData(doctor);
  await expect(doctor.getByRole('button', { name: 'Start Session' })).toBeHidden();

  // The pharmacy PIN is not the doctor PIN.
  await enterPin(doctor, PINS.pharmacy);
  await expect(doctor.getByRole('alert')).toHaveText('Wrong PIN. 4 tries left.');
  await expect(doctor.getByLabel('Enter PIN')).toHaveValue('');
  await expectLocked(doctor, 'Doctor');

  await enterPin(doctor, PINS.doctor);
  await expect(doctor.getByLabel('Enter PIN')).toHaveCount(0);
  await expect(doctor.locator('#conn')).toHaveText('Connected');
  await expect(doctor.locator('#no-session:visible, #session:visible')).toBeVisible();

  // The login cookie is httpOnly: page scripts cannot read it.
  expect(await doctor.evaluate(() => document.cookie)).not.toContain('rx_doctor');
  const cookie = (await doctor.context().cookies()).find((c) => c.name === 'rx_doctor');
  expect(cookie.httpOnly).toBe(true);
  // (SameSite=Strict is checked on the Set-Cookie header in the integration
  // tests: Windows WebKit reports every cookie's sameSite as "None".)

  // A reload stays logged in.
  await doctor.reload();
  await expect(doctor.locator('#conn')).toHaveText('Connected');
  await expect(doctor.getByLabel('Enter PIN')).toHaveCount(0);

  // The doctor login does not open the pharmacy screen.
  await doctor.goto('/pharmacy/');
  await expectLocked(doctor, 'Pharmacy');
});

test('scenario 1: the pharmacy screen is blocked until the pharmacy PIN is entered', async ({ pharmacy }) => {
  await pharmacy.goto('/pharmacy/');
  await expectLocked(pharmacy, 'Pharmacy');
  await expectNoData(pharmacy);
  await expect(pharmacy.getByRole('button', { name: 'Start receiving' })).toBeHidden();

  await enterPin(pharmacy, PINS.doctor);
  await expect(pharmacy.getByRole('alert')).toHaveText('Wrong PIN. 4 tries left.');
  await expectLocked(pharmacy, 'Pharmacy');

  // Enter submits too, like a keypad.
  await pharmacy.getByLabel('Enter PIN').fill(PINS.pharmacy);
  await pharmacy.keyboard.press('Enter');
  await expect(pharmacy.getByRole('button', { name: 'Start receiving' })).toBeVisible();
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');
});

test('the PIN screen counts down a lockout and then allows another try', async ({ pharmacy }) => {
  // The server's lockout itself is covered by the integration tests; here
  // the reply is faked so the shared test server is never locked.
  await pharmacy.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Too many wrong PINs.', retryAfter: 2 })
    })
  );
  await pharmacy.goto('/pharmacy/');
  await enterPin(pharmacy, '0000');
  const alert = pharmacy.getByRole('alert');
  await expect(alert).toHaveText(/Too many wrong PINs\. Try again in [12] seconds\./);
  await expect(pharmacy.getByRole('button', { name: 'Unlock' })).toBeDisabled();
  await expect(pharmacy.getByLabel('Enter PIN')).toBeDisabled();

  await pharmacy.unroute('**/api/auth/login');
  await expect(pharmacy.getByRole('button', { name: 'Unlock' })).toBeEnabled({ timeout: 5000 });
  await expect(alert).toHaveText('');
  await enterPin(pharmacy, PINS.pharmacy);
  await expect(pharmacy.getByRole('button', { name: 'Start receiving' })).toBeVisible();
});

test('an expired or removed login sends the screen back to the PIN', async ({ pharmacy }) => {
  await pharmacy.addInitScript(exposeSocket);
  await pharmacy.goto('/pharmacy/');
  await enterPin(pharmacy, PINS.pharmacy);
  await expect(pharmacy.locator('#conn')).toHaveText('Connected');

  // As if the login expired while connected: drop the connection, so the
  // automatic reconnect is refused and the page goes back to its PIN screen.
  await pharmacy.context().clearCookies();
  await pharmacy.evaluate(() => window.__socket.io.engine.close());
  await expectLocked(pharmacy, 'Pharmacy');
  await expectNoData(pharmacy);
});
