# e-Prescription System

Local-network handoff between a doctor's tablet and a pharmacy PC for one
channeling center. Full requirements: [`docs/SPEC.md`](docs/SPEC.md). Working
agreements and hard rules: [`CLAUDE.md`](CLAUDE.md).

## Setup

Requires Node.js 22 LTS or newer.

```
npm install
npx playwright install chromium webkit   # once, for the e2e tests
```

`postinstall` copies `signature_pad` and the Socket.IO browser client into
`public/vendor/` so the app never loads a library from a CDN.

The e2e tests start their own server on a free port with a throwaway
`DATA_DIR` and `ARCHIVE_DIR` in the OS temp folder, so they never touch
`data/`. Use the `doctor` (1024x1366, touch) and `pharmacy` (1366x768) pages
from `tests/e2e/fixtures.js` in new specs.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Start the server with nodemon on `PORT` (default 3000) |
| `npm start` | Start the server |
| `npm test` | Unit + integration tests (`node:test`) |
| `npm run test:e2e` | End-to-end tests (Playwright, Chromium + WebKit) |
| `npm run test:all` | Everything — must pass before any phase is done |

## Configuration

Read from environment variables in `src/config.js`, each with a safe
development default:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database (`e-prescription.db`) and handwriting PNGs (`images/<prescription id>.png`, max 3 MB each). Back up the whole folder. |
| `ARCHIVE_DIR` | `./data/archive` | Where session PDFs are written (point this at the Google Drive for Desktop sync folder in production) |
| `DOCTOR_PIN` | `1234` | PIN for the doctor screen |
| `PHARMACY_PIN` | `5678` | PIN for the pharmacy screen |

## Layout

```
server.js        Express + Socket.IO entry point
src/             config, db, ids, sessions, prescriptions, validation, png (handwriting checks), socket (events), api (REST)
public/doctor/   doctor screen (pad.js: handwriting canvas; portrait only, see below)
public/pharmacy/ pharmacist screen
public/shared/   CSS, client.js helpers, alert.wav (regenerate: node scripts/make-alert-sound.js)
public/vendor/   signature_pad, socket.io client (served locally, regenerated on install)
tests/unit/      node:test
tests/integration/  node:test with socket.io-client
tests/e2e/       Playwright specs
data/            database, images, test archive (gitignored)
```

## Handwriting pad: portrait only

The handwriting canvas is sized once, in portrait, and never resized while it
holds a drawing. If the iPad is rotated (or the browser is made narrower,
e.g. Split View), the pad is covered by "Rotate back to portrait to
continue." and Send is refused until it is upright again; the drawing is
kept exactly as it was. Typed prescriptions work in any orientation.
signature_pad is pinned to 5.1.7 because `public/doctor/pad.js` draws the
final segment of each stroke that this version leaves out. Before upgrading
it, run `npx playwright test tests/e2e/pad-marks.spec.js tests/e2e/pad-rotation.spec.js`.
