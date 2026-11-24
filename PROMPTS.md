# Claude Code prompts — e-Prescription System

How to use:
- One phase per conversation. Start a new conversation in the Claude Code panel for each phase.
- Type `/plan` first, paste the prompt, read the plan, approve it, then let Claude build.
- When Claude reports DONE with the phase-done checklist, try the "by hand" items it lists, then commit.
- If a phase goes wrong, `git restore .` and run the prompt again with a note about what went wrong.

---

## Phase 0 — Read and plan (no code)

```
Read CLAUDE.md and docs/SPEC.md carefully. Do not write any code yet.

1. Summarise the system in 5 bullet points so I can confirm you understood it.
2. Propose the build order for phases 1–9 as listed in PROMPTS.md, and say if you would change anything and why.
3. List every question where the spec is unclear or two readings are possible. For each, give the option you recommend.
4. List the npm packages you will use, with one line each on why.
```

## Phase 1 — Project scaffold and test harness

```
Phase 1: set up the project skeleton and the test harness. No features yet.

- package.json with scripts: dev, start, test (node:test, unit + integration), test:e2e (Playwright), test:all.
- Install: express, socket.io, better-sqlite3, pdfkit, signature_pad; dev: nodemon, @playwright/test, socket.io-client, pdf-parse.
- A postinstall script that copies signature_pad and the socket.io browser client into public/vendor/ so nothing loads from a CDN.
- src/config.js reading PORT, DATA_DIR, ARCHIVE_DIR, DOCTOR_PIN, PHARMACY_PIN from environment variables with safe defaults.
- The folder layout in CLAUDE.md, a .gitignore (node_modules, data/, test-results/), and a short README.
- server.js that serves public/ and returns 200 on GET /health.
- playwright.config.js: Chromium and WebKit projects, webServer that starts the app on a free port with a temporary DATA_DIR and ARCHIVE_DIR.
- One passing smoke test at each level: unit, integration (GET /health), e2e (doctor and pharmacy pages load).

Install the Playwright browsers if needed. Run npm run test:all and show me the output. Then run the phase-done skill.
```

## Phase 2 — Core handoff (typed prescriptions)

```
Phase 2: the core doctor-to-pharmacist handoff for typed prescriptions, as in docs/SPEC.md.

Server:
- src/db.js: SQLite in WAL mode, sessions and prescriptions tables exactly as in the spec, created on startup.
- src/ids.js: RX-YYYYMMDD-NNNN IDs, running number per day, safe across restarts and midnight.
- Socket.IO events with acknowledgements: session:start, prescription:new. Save to SQLite before acking or broadcasting.
- REST: GET /api/session/current, GET /api/prescriptions?session=<id>.
- Reject a prescription with no patient ref or no open session, with a clear error in the ack.

Doctor page (public/doctor/): Start Session button, then a form with patient ID/token (required) and one or more lines of medicine, dosage and instructions, and Send. Show "Sent" only after the ack. Show a list of this session's prescriptions with their status. Design it for an iPad held upright: large touch targets.

Pharmacy page (public/pharmacy/): live queue in arrival order, each card showing ID, patient ref, time and the typed lines. Loads current state on open.

Tests: unit tests for ids.js and validation; integration tests with two socket.io clients (doctor and pharmacy) covering send, receive within 1 s, and saved-before-ack; e2e scenarios 2 and 9 from the e2e-handoff-test skill.

Run npm run test:all, check both screens with the Playwright MCP browser at iPad and desktop sizes, then run the phase-done skill.
```

## Phase 3 — Handwritten prescriptions

```
Phase 3: handwritten prescriptions.

- Doctor page: a Typed / Handwrite toggle. Handwrite shows a signature_pad canvas that fills the width, with Clear and Undo buttons, and the same required patient ID/token field. It must work with a stylus, a finger and a mouse, and must not scroll the page while drawing.
- Send the drawing as a PNG. Server: accept PNG only, limit size (for example 3 MB), save to DATA_DIR/images/<prescription id>.png, store the path, never convert to text.
- GET /api/prescriptions/<id>/image serves the PNG.
- Pharmacy page: handwritten cards show the image at a readable size; tapping it opens it full screen.
- Reject an empty canvas.

Tests: unit test for PNG validation; integration test that the image round-trips byte-for-byte; e2e scenario 3 (draw with mouse moves in Chromium and WebKit, confirm the pharmacy shows an <img>, not text).

Run npm run test:all, look at the canvas and the pharmacy card in the Playwright MCP browser, then run the phase-done skill.
```

## Phase 4 — Alerts, dispensed status and sessions

```
Phase 4: queue features.

- Pharmacy page: when a new prescription arrives, play public/shared/alert.mp3 (generate or add a short, pleasant chime; no copyrighted audio) and show an on-screen notice that stays until clicked. Browsers block sound until the user interacts, so the pharmacist must tap a "Start receiving" button once before the queue shows.
- Dispensed: a button on each card. Event prescription:dispensed with ack; the card moves to a "Dispensed" section; the doctor's list shows Dispensed within 1 s.
- End Session on the pharmacy page with a confirmation dialog. It closes the session (PDF comes in phase 6). Both screens return to their start state. Only one open session at a time.
- Both screens show a clear connection indicator (connected / reconnecting).

Tests: integration tests for dispensed and session lifecycle; e2e scenarios 2 (sound + notice, using the play() spy), 4 and 5.

Run npm run test:all, check both screens in the Playwright MCP browser, then run the phase-done skill.
```

## Phase 5 — PIN screens and access control

```
Phase 5: simple PIN protection per role.

- A PIN screen in front of the doctor page and the pharmacy page. PINs come from DOCTOR_PIN and PHARMACY_PIN.
- On a correct PIN the server sets a signed, httpOnly session cookie for that role. Every REST route and every Socket.IO connection checks it; the doctor role cannot mark dispensed or end sessions, and the pharmacy role cannot send prescriptions.
- Lock out for 1 minute after 5 wrong attempts.
- Keep it simple: no user accounts.

Tests: integration tests that each route and event refuses a missing or wrong role; e2e scenario 1. Update the existing e2e tests to log in first.

Run npm run test:all, then run the phase-done skill.
```

## Phase 6 — Session archive PDF

```
Phase 6: archive every session to one PDF when it ends.

- src/archive.js: on session:end, build one PDF with pdfkit: clinic name and session date/time range at the top, then each prescription in order with ID, patient ref, sent time, dispensed time, and either the typed lines or the handwriting image scaled to fit the page width without distortion.
- Write it to ARCHIVE_DIR as YYYY-MM-DD_session-<id>.pdf. Write to a temp file first, then rename, so Drive never syncs a half-written file. Record archive_file and archived_at.
- If writing fails, keep the session closed, retry with backoff, and show a warning banner on the pharmacy page until it succeeds. Never delete prescriptions.

Tests: integration test that reads the PDF with pdf-parse and finds every prescription ID; a test with an unwritable ARCHIVE_DIR that checks the warning and that nothing is lost; e2e scenario 8.

Run npm run test:all, open one generated PDF and describe what it looks like (render a page to PNG and look at it if you can), then run the phase-done skill.
```

## Phase 7 — Resilience and safety review

```
Phase 7: make it survive a real clinic day.

- Both screens resync the session and queue on every reconnect, and the doctor page re-sends nothing twice (use a client-generated request ID so a retried send is not duplicated).
- Graceful shutdown on SIGINT/SIGTERM; the server starts cleanly after a crash with the same data.
- Add e2e scenarios 6 (offline for a few seconds) and 7 (server restart mid-session).
- Then run the safety-review skill on the whole codebase. Fix every High finding with a test, and list Medium and Low ones for me.

Run npm run test:all twice in a row to catch flaky tests, then run the phase-done skill.
```

## Phase 8 — Deployment kit for the clinic PC

```
Phase 8: everything needed to install on the Windows pharmacy PC.

- deploy/install.ps1: checks Node.js, runs npm ci --omit=dev, creates the data folder, adds a Windows Firewall rule for TCP 3000 on the Private profile only, and installs the app as a Windows service with NSSM running as the current Windows user. Idempotent: safe to run twice.
- deploy/uninstall.ps1 and deploy/backup.ps1 (copies data/ to a dated folder in the archive location).
- deploy/.env.example with every setting and a comment on each.
- docs/INSTALL.md: a step-by-step guide for a non-developer: router DHCP reservation, Google Drive for Desktop in Mirror mode, running install.ps1, setting PINs, adding the doctor page to the iPad home screen, turning off PC sleep, and a 5-minute smoke test.
- A GET /health response that includes version, uptime, database OK and archive folder writable, shown as a small status line on the pharmacy page.

Check the PowerShell scripts with PSScriptAnalyzer if available, otherwise review them line by line. Run npm run test:all, then run the phase-done skill.
```

## Phase 9 — Final check before the clinic trial

```
Phase 9: final verification.

1. Run npm run test:all three times; report any test that failed even once.
2. Run the safety-review skill again and the /code-review skill on the whole project.
3. Using the Playwright MCP browser, walk through one full clinic session (PINs, start, 3 typed and 2 handwritten prescriptions, dispense all, end session) at iPad and desktop sizes, and save the screenshots to docs/screenshots/.
4. Check docs/INSTALL.md against the actual scripts and config.
5. Give me a release summary: what works, known limitations, and the list of things I must test by hand on the real iPad, PC and router.
```

---

## Handy prompts for any time

**A test keeps failing**
```
The test <name> fails. Find the root cause before changing code: read the error, trace and screenshot in test-results/, form a hypothesis, prove it, then fix the app (not the test, unless the test is wrong—explain why). Rerun the full suite.
```

**Bug found by hand**
```
Bug: <what I did> → <what happened> → <what I expected>. Device/browser: <iPad Safari / PC Chrome>. First write a failing test that reproduces it, then fix it, then run npm run test:all.
```

**Small change request**
```
/plan Change: <describe>. Keep everything else as is. Update the tests and SPEC.md if behaviour changes. Run npm run test:all and the phase-done skill.
```
