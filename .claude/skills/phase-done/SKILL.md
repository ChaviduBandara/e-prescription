---
name: phase-done
description: Definition-of-done checklist for a build phase of the e-Prescription System. Use when you believe a phase is finished, before telling the user it is done.
---

# Phase done checklist

Do every step. Do not tell the user a phase is done until all of them pass.

## Current state
!`git status --short`

## Steps

1. Run `npm run test:all`. Paste the summary (passed / failed / skipped counts).
2. Run the `e2e-handoff-test` skill for the scenarios this phase touches.
3. Open the changed screens in the Playwright MCP browser at iPad (1024x1366) and desktop (1366x768) sizes. Look at the screenshots. Fix anything cut off, overlapping or unreadable.
4. Check the hard rules in CLAUDE.md against this phase's diff:
   - no OCR or handwriting-to-text
   - no CDN or runtime internet calls (search the diff for `http://` and `https://`)
   - save before acknowledge
   - no deletes of prescriptions
   - no real-looking patient data
5. Update `README.md` if commands, config or setup changed.
6. Report to the user in this shape:

```
Phase <n> — <name>: DONE / NOT DONE
Tests: <unit+integration counts>, <e2e counts>
Screens checked: <list>
Hard rules: OK / <problems>
What the user should try by hand: <1–3 items, or "nothing">
Suggested commit message: <one line>
```

Do not commit. The user reviews and commits.
