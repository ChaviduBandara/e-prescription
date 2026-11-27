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
`data/`. When the run ends, `tests/e2e/global-teardown.js` tells that server
(`tests/e2e/web-server.js`) to close and delete the temp folder, so no data
or server process is left behind. Use the `doctor` (1024x1366, touch) and
`pharmacy` (1366x768) pages from `tests/e2e/fixtures.js` in new specs.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Start the server with nodemon on `PORT` (default 3000), in development mode (`nodemon.json` sets `NODE_ENV=development`, which allows the default PINs) |
| `npm start` | Start the server. Needs `DOCTOR_PIN` and `PHARMACY_PIN` |
| `npm test` | Unit + integration tests (`node:test`) |
| `npm run test:e2e` | End-to-end tests (Playwright, Chromium + WebKit) |
| `npm run test:all` | Everything — must pass before any phase is done |

## Configuration

Read from environment variables in `src/config.js`. Everything has a
default except the PINs, which only have one in development mode:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database (`e-prescription.db`) and handwriting PNGs (`images/<prescription id>.png`, max 3 MB each). Back up the whole folder. |
| `ARCHIVE_DIR` | `./data/archive` | Where session PDFs are written (point this at the Google Drive for Desktop sync folder in production) |
| `DOCTOR_PIN` | none (`1234` in development mode only) | PIN for the doctor screen, 4–32 characters. **Required**: without it the server refuses to start, so no screen is ever left open on the WiFi. |
| `PHARMACY_PIN` | none (`5678` in development mode only) | PIN for the pharmacy screen. Required, and must differ from `DOCTOR_PIN`. |
| `CLINIC_NAME` | `Channeling Center` | Printed at the top of every archive PDF |
| `SESSION_SECRET` | random, kept in `DATA_DIR/session-secret` | Signs the login cookies. Optional; leave unset to use the generated file. |

## Layout

```
server.js        Express + Socket.IO entry point
src/             config, db, ids, sessions, prescriptions, validation, png (handwriting checks), auth (PIN login), archive (session PDF), pdf-text (Sinhala/Tamil/Latin text in the PDF), socket (events), api (REST)
src/fonts/       Noto Sans Sinhala and Noto Sans Tamil for the archive PDF (SIL Open Font License, see src/fonts/README.md)
public/doctor/   doctor screen (pad.js: handwriting canvas; portrait only, see below)
public/pharmacy/ pharmacist screen (alerts.js: Start receiving, sound, notice; end-session.js; image-view.js: handwriting loading/error states)
public/shared/   CSS, client.js helpers, auth.js (PIN screen), alert.wav (regenerate: node scripts/make-alert-sound.js)
public/vendor/   signature_pad, socket.io client (served locally, regenerated on install)
tests/server-process.js  runs `node server.js` as a separate process, to kill it hard and restart it
tests/e2e/web-server.js, global-teardown.js  the e2e run's server, and its clean-up
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

## Handwriting on the pharmacy screen: never blank

A handwritten card shows "Loading prescription image…" until the PNG has
decoded, then the image. If it fails it shows "Image failed to load" with a
Retry button, and every failed image is retried automatically when the
connection to the server comes back. See `public/pharmacy/image-view.js` and
`tests/e2e/pharmacy-image.spec.js`.

## Pharmacy screen: daily use

- **Start receiving.** Browsers block sound until the page is clicked, so
  after every page load the pharmacist taps **Start receiving** once. This
  turns on the alert chime (`public/shared/alert.wav`) and shows the queue.
- **New prescriptions** play the chime and show a blue strip under the top
  bar. It stays until it is clicked (or OK is pressed) and counts any that
  arrived meanwhile.
- **Dispensed** on a card moves it to the Dispensed section. The doctor's
  list shows it as Dispensed within a second.
- **End Session** (top right) asks for confirmation, warns if any are not
  marked Dispensed, then closes the session. Both screens go back to their
  start state; prescriptions stay in the database. The session is archived
  as a PDF (see below).
- **Connection.** Both screens show Connected / Reconnecting… at the top
  right, and a red strip while the connection is down. They reload the
  session and queue on their own when it comes back.

## PIN protection

Each screen opens on a PIN screen. The right PIN (`DOCTOR_PIN` or
`PHARMACY_PIN`) sets a signed, httpOnly cookie for that role, valid for
24 hours, so a tablet or PC asks again once a day. There are no user accounts.

- Every `/api` route except login needs a doctor or pharmacy login. Both
  roles can read the session and queue.
- Every Socket.IO connection needs one too. The doctor can only start
  sessions and send prescriptions; the pharmacy can only mark Dispensed
  and end sessions.
- 5 wrong PINs lock that role out on that device (IP address) for 1 minute.
- 20 wrong PINs for one role within 10 minutes, from any devices, lock that
  role out on every device for 5 minutes ("Too many wrong PINs for this
  screen"), even with the right PIN. The other screen is not affected. This
  stops guessing from a device that keeps changing its IP address. The
  server logs a warning when it happens.
- The per-device table forgets devices after 10 quiet minutes and holds at
  most 1000, so it cannot grow without limit.
- Changing a PIN (and restarting the server) logs that role out everywhere.
  So does deleting `DATA_DIR/session-secret`.

## Session archive (PDF)

When the pharmacist ends a session, the server writes one PDF to
`ARCHIVE_DIR` named `YYYY-MM-DD_session-<id>.pdf` (the date the session
started). It holds the clinic name, the session's start and end times, then
every prescription in arrival order: ID, patient ref, sent and dispensed
times, and the typed lines or the handwriting image as drawn (scaled to the
page width, never stretched, always on the same page as its ID).

- The PDF is written to a hidden `.…partial` file in the same folder, flushed
  to disk and then renamed, so Google Drive never syncs a half-written file.
- An existing file is never overwritten; a clash (e.g. after starting a new
  database) gets `_2`, `_3` … added. A session always makes the same PDF
  bytes (it is dated by the session, not the clock), so if the server died
  after writing the file but before recording it, the identical file already
  there is recorded instead of writing a `_2` copy.
- **Sinhala and Tamil.** Typed text, patient refs and the clinic name are
  printed per run of text: Latin in Helvetica, Sinhala and Tamil in the
  bundled Noto Sans fonts (`src/fonts/`, nothing downloaded). Shaping is done
  by pdfkit's fontkit, checked by rendering sample pages:
  - Tamil, and Sinhala vowel signs, conjuncts, yansaya and rakaransaya
    (ශ්‍රී, ක්‍ර, ප්‍ර) print correctly. fontkit gives some Sinhala mark
    glyphs their own width, leaving a gap after ක්‍ර, ශ්‍රී …;
    `src/pdf-text.js` gives marks zero width as browsers (HarfBuzz) do, for
    the Sinhala fonts only.
  - **Known limit:** the repaya form (ර් + ZWJ + consonant, as in ධර්‍ම) is
    not formed; it prints as ර් followed by the consonant (ධර්ම), which reads
    the same.
  - A character none of the fonts can print (emoji, arrows, Chinese …) is
    printed as a red `?` and the prescription gets a red line naming it, e.g.
    "Some characters could not be printed (shown as ?): U+2192 … Check
    RX-… in the e-Prescription system." Nothing is dropped silently.
- If the folder cannot be written (Drive not running, disk full, …) the
  session still closes and nothing is lost. The pharmacy screen shows a
  yellow warning, and the server retries after 5 s, 10 s, 20 s … up to every
  5 minutes until it works. Sessions left without a PDF (e.g. the PC was
  switched off) are archived when the server next starts.
- The pharmacy's "session ended" message names the archive file.

## Surviving a clinic day (WiFi drops, restarts, crashes)

- **No double sends.** Each tap on Send gets a random request ID. Until the
  server confirms, the doctor's form is locked and shows "NOT sent yet" or
  "No reply yet". The page sends the same prescription and ID again after a
  timeout or as soon as the connection is back. The server stores the ID
  (`request_id`, unique) and answers a repeat with the prescription it
  already saved, so nothing is saved or announced twice.
- **A waiting send survives a reload.** Until the server replies, the send
  (exact payload, handwriting PNG and request ID) is kept in the tab's
  `sessionStorage`. If the page is reloaded it is put back in the form, the
  drawing redrawn at the same size, and sent again with the same ID; it is
  removed from storage as soon as the server replies. If the tablet cannot
  store it (storage full), the status says the send will be lost on reload.
  Closing the tab drops it; the list shows what was really saved.
- **A late send never lands in the wrong session.** The tablet sends the ID
  of the session it was in. If that session has ended by the time the send
  arrives, the server refuses it ("The session ended before this was sent.
  Start a new session and send again.") and the prescription stays filled in
  on the tablet, also after Start Session, to be sent in the new session.
- **Resync.** Both screens reload the open session and queue on every
  reconnect. The pharmacy announces prescriptions it only learns about
  through that reload, like live ones.
- **Dead connections are noticed in about 15 s** (Socket.IO ping every 10 s,
  5 s to answer), and a reconnect attempt that hangs is retried after 5 s.
- **Stopping.** Ctrl+C, SIGTERM or a Windows service stop (NSSM sends
  Ctrl+C; keep its default stop method) closes the connections, lets a PDF
  being written finish, closes the database and exits. It exits anyway after
  10 s.
- **After a crash or power cut** the server starts on the same data: SQLite
  (WAL, `synchronous=FULL`) recovers committed prescriptions, the open
  session carries on, logins stay valid, half-written `.partial` PDFs are
  removed, and sessions closed without a PDF are archived.
