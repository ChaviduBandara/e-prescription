---
name: safety-review
description: Reviews the e-Prescription code for patient-safety, data-loss and privacy risks. Use when asked for a safety or security review, and before the clinic trial.
---

# Safety review

This app carries prescriptions. A lost, duplicated, misattributed or misread prescription can hurt a patient. Review the whole codebase, not just the last diff.

## Check each item and report file:line for every finding

**Prescription integrity**
- Can a prescription be acknowledged to the doctor before it is saved?
- Can two prescriptions get the same ID (concurrent sends, server restart, midnight rollover)?
- Can a prescription be attached to the wrong session or wrong patient ref?
- Can a handwritten image be lost, cropped, scaled unreadably or swapped with another?
- Is there any path that converts handwriting to text? (Must be none.)

**Data loss**
- What happens on a crash or power cut mid-write? Is SQLite in WAL mode?
- Can End Session lose prescriptions if PDF writing fails?
- Is anything ever deleted?

**Access and privacy**
- Are both screens and every API route and socket event behind the PIN?
- Can a device on the WiFi call the API without a PIN?
- Is patient data written to logs, error messages or the browser console?
- Are uploads size-limited and type-checked (PNG only)?
- Any user input rendered with `innerHTML` (XSS)?

**Offline**
- Any runtime request to the internet (CDN, fonts, analytics)?

## Output

A table: severity (High / Medium / Low), finding, file:line, fix. Then fix every High finding, add a test for each, and rerun `npm run test:all`. List Medium and Low findings for the user to decide.
