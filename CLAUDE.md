# e-Prescription System

A local-network web app for one channeling center. The doctor sends prescriptions from a tablet; the pharmacist sees them instantly on the pharmacy PC, marks them dispensed, and ends the session, which archives one dated PDF to a Google Drive for Desktop sync folder.

Full requirements: @docs/SPEC.md — read it before planning any phase.

## Stack (do not change without asking)

- Node.js LTS, CommonJS, Express, Socket.IO, better-sqlite3, pdfkit
- Frontend: plain HTML, CSS and JavaScript in `public/`. No framework, no build step.
- Handwriting: signature_pad, exported as PNG
- Tests: `node:test` for unit and integration, `@playwright/test` for end-to-end

## Commands

- `npm run dev` — start with nodemon on port 3000
- `npm test` — unit + integration tests (node:test)
- `npm run test:e2e` — Playwright end-to-end tests (Chromium + WebKit)
- `npm run test:all` — everything; must pass before any phase is called done

## Hard rules

1. **Never send handwriting through OCR or any text conversion.** Handwritten prescriptions are stored and shown as PNG images, exactly as drawn.
2. **No CDN links or internet calls at runtime.** Serve every library from `public/vendor/`. The handoff must work with the internet unplugged.
3. **Save before you confirm.** The server writes a prescription to SQLite before it acknowledges the tablet or pushes it to the pharmacy screen.
4. **Never delete prescriptions** after archiving. Archiving only adds a PDF.
5. **No real patient data** in code, tests, fixtures, logs or screenshots. Use obviously fake data such as `TOKEN-001` and `Test Medicine 10mg`.
6. Config (port, archive folder, PINs) comes from `config.js` / environment variables, never hardcoded paths.
7. SQLite runs in WAL mode.

## How to work

- Work one phase at a time, as the prompt says. Plan first, then build.
- Write or update tests in the same change as the code they cover.
- A task is done only when `npm run test:all` passes **and** you have looked at the affected screens with the Playwright MCP browser (doctor view at iPad size 1024x1366, pharmacy view at 1366x768) and checked the screenshots yourself.
- When you finish a phase, use the `phase-done` skill and report its checklist.
- If a requirement in SPEC.md is unclear, ask instead of guessing.
- Keep files small and readable; this code will be maintained by a small team.

## Layout

```
server.js        Express + Socket.IO entry point
src/             db.js, ids.js, archive.js, sessions.js, config.js
public/doctor/   doctor screen
public/pharmacy/ pharmacist screen
public/shared/   CSS, alert sound
public/vendor/   signature_pad, socket.io client (served locally)
tests/unit/      node:test
tests/integration/  node:test with socket.io-client
tests/e2e/       Playwright specs
data/            database, images, test archive (gitignored)
```
