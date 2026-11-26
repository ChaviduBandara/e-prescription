# e-Prescription System — Specification (phase 1)

Client: a single channeling center. Builder: CIIGUS Software.

## Problem

Paper prescriptions are walked from the doctor to the in-house pharmacy. The pharmacist cannot start until the paper arrives, paper costs money, and there is no digital record.

## Users and devices

| User | Device | Opens |
|---|---|---|
| Doctor | iPad or Android tablet with stylus | `http://<pharmacy-pc-ip>:3000/doctor/` |
| Pharmacist | Existing pharmacy PC (also runs the server) | `http://localhost:3000/pharmacy/` |

## Flow

1. Doctor taps **Start Session**. Only one session can be open at a time.
2. For each patient the doctor enters the **patient ID or token number** (required) and either:
   - **Typed**: one or more lines of medicine, dosage, instructions; or
   - **Handwritten**: draws on a canvas with the stylus (with Clear and Undo). Handwriting works in portrait only: rotating locks the pad until it is upright again, and the drawing is kept. Typed works in any orientation.
   Then taps **Send**. The screen shows "Sent" only after the server confirms it saved.
3. The server saves it, assigns a unique ID (`RX-YYYYMMDD-NNNN`, running number per day), and pushes it to the pharmacy screen.
4. The pharmacy screen shows it at the bottom of the live queue with an **on-screen notice and an alert sound**.
5. The pharmacist opens it, prepares the medicine, taps **Dispensed**. The doctor's screen shows that prescription as Dispensed within a second.
6. Steps 2–5 repeat.
7. The pharmacist taps **End Session** (with a confirmation). The server builds **one dated PDF** of every prescription in the session (ID, patient ref, date and time, typed text or the handwriting image, dispensed time) and writes it to the archive folder, which is a Google Drive for Desktop sync folder. File name: `YYYY-MM-DD_session-<id>.pdf`.

## Rules

- Handwriting is never converted to text. It is shown and archived as the image.
- A handwritten prescription is never shown as a blank image: the pharmacy screen shows a loading message until the image has decoded, or an error with Retry.
- The handoff works with no internet. Only Drive's own sync needs internet.
- Both screens reload the open session and queue on load and on reconnect.
- A simple PIN screen per role (doctor PIN, pharmacist PIN, from config) protects each screen.
- If the PDF cannot be written, the server retries and the pharmacy screen shows a warning. Prescriptions stay in the database regardless.

## Data

- `sessions`: id, started_at, ended_at, status (`open`/`closed`), archive_file, archived_at
- `prescriptions`: id, session_id, patient_ref, kind (`typed`/`handwritten`), typed_body (JSON), image_path, status (`sent`/`dispensed`), created_at, dispensed_at, request_id (the doctor page's ID for one tap on Send, unique, so a retried send is not saved twice)
- Handwriting PNGs live in `data/images/`; the database stores the path.

## Real-time events (Socket.IO, with acknowledgements)

| Event | From | Server does |
|---|---|---|
| `session:start` | doctor | open session, broadcast `session:started` |
| `prescription:new` | doctor | save, assign ID, ack, broadcast `prescription:new` |
| `prescription:dispensed` | pharmacist | update, ack, broadcast `prescription:dispensed` |
| `session:end` | pharmacist | close, build PDF, ack, broadcast `session:ended` |

REST for loading state: `GET /api/session/current`, `GET /api/prescriptions?session=<id>`, `GET /api/prescriptions/<id>/image`.

## Out of scope (phase 1)

Paper scanning, OCR, multiple pharmacy counters or branches, integration with other clinic systems, cloud hosting.

## Deployment target

Windows pharmacy PC with a fixed LAN IP, firewall rule for port 3000 (private network only), server run as a Windows service (NSSM) under the pharmacist's Windows user, Google Drive for Desktop in Mirror mode.
