// Phase 6: End Session archives the session as one dated PDF.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { startTestServer, nextEvent } = require('./server-harness');
const { fakeTyped, fakeHandwritten, makePng } = require('../helpers');

const ACK_MS = 5000;

async function pdfText(file) {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Opens a session and sends a typed, a handwritten and a dispensed prescription.
async function sessionWithPrescriptions(t, options) {
  const harness = await startTestServer(t, options);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const send = async (payload) => (await doctor.timeout(ACK_MS).emitWithAck('prescription:new', payload)).prescription;
  const typed = await send(
    fakeTyped({
      patientRef: 'TOKEN-001',
      lines: [
        { medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily after meals' },
        { medicine: 'Test Syrup 5ml', dosage: '5 ml', instructions: 'At night' }
      ]
    })
  );
  const drawn = await send(fakeHandwritten({ patientRef: 'TOKEN-002', image: makePng({ width: 600, height: 900 }) }));
  const dispensed = await send(fakeTyped({ patientRef: 'TOKEN-003' }));
  await pharmacy.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id: dispensed.id });
  const end = () => pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id });
  return { ...harness, doctor, pharmacy, session, prescriptions: [typed, drawn, dispensed], end };
}

function prescriptionRows(db, sessionId) {
  return db.prepare('SELECT * FROM prescriptions WHERE session_id = ? ORDER BY id').all(sessionId);
}

test('session:end writes one dated PDF with every prescription and records it', async (t) => {
  const { db, archiveDir, session, prescriptions, end, doctor } = await sessionWithPrescriptions(t);
  const ended = nextEvent(doctor, 'session:ended', ACK_MS);
  const res = await end();

  const name = `${localDate()}_session-${session.id}.pdf`;
  assert.equal(res.ok, true);
  assert.deepEqual(res.archive, { ok: true, file: name });
  assert.equal(res.session.archiveFile, name);
  assert.ok(res.session.archivedAt);
  assert.equal((await ended).archiveFile, name, 'the broadcast carries the file name too');

  // Exactly one file, no temp file left behind.
  assert.deepEqual(fs.readdirSync(archiveDir), [name]);
  const row = db.prepare('SELECT archive_file, archived_at, status FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.archive_file, name);
  assert.equal(row.status, 'closed');
  assert.ok(row.archived_at);

  const text = await pdfText(path.join(archiveDir, name));
  assert.match(text, /Test Clinic/);
  assert.match(text, new RegExp(`Session ${session.id}`));
  for (const rx of prescriptions) {
    assert.match(text, new RegExp(rx.id), rx.id);
    assert.match(text, new RegExp(rx.patientRef), rx.patientRef);
  }
  assert.match(text, /Test Medicine 10mg/);
  assert.match(text, /Twice daily after meals/);
  assert.match(text, /Test Syrup 5ml/);
  assert.match(text, /Not dispensed/);
  assert.match(text, /3 prescriptions, 1 dispensed/);
  // In arrival order.
  const at = prescriptions.map((rx) => text.indexOf(rx.id));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  // Prescriptions are untouched (hard rule 4).
  assert.equal(prescriptionRows(db, session.id).length, 3);
});

test('the handwriting goes into the PDF as an image, not text', async (t) => {
  const { archiveDir, end } = await sessionWithPrescriptions(t);
  const res = await end();
  const parser = new PDFParse({ data: fs.readFileSync(path.join(archiveDir, res.session.archiveFile)) });
  try {
    const { pages } = await parser.getImage();
    const images = pages.flatMap((p) => p.images);
    assert.equal(images.length, 1);
    // Same pixels as drawn: 600x900, no distortion.
    assert.equal(images[0].width, 600);
    assert.equal(images[0].height, 900);
  } finally {
    await parser.destroy();
  }
});

test('an unwritable ARCHIVE_DIR: the session closes, nothing is lost, the pharmacy is warned until a retry works', async (t) => {
  // ARCHIVE_DIR under a plain file can never be created: like a Drive
  // folder that is missing or not mounted.
  const blockerRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'e-prescription-blocked-'));
  t.after(() => fs.rmSync(blockerRoot, { recursive: true, force: true }));
  const blocker = path.join(blockerRoot, 'not-a-folder');
  fs.writeFileSync(blocker, 'test');
  const archiveDir = path.join(blocker, 'archive');

  const { db, session, prescriptions, end, pharmacy, getJson } = await sessionWithPrescriptions(t, {
    archiveDir,
    archiveOptions: { firstDelayMs: 150, maxDelayMs: 300 }
  });
  const warned = nextEvent(pharmacy, 'archive:status', ACK_MS);
  const res = await end();

  // The session is closed regardless, and the reply says the PDF failed.
  assert.equal(res.ok, true);
  assert.equal(res.session.status, 'closed');
  assert.equal(res.archive.ok, false);
  assert.match(res.archive.error, /archive folder/);
  assert.ok(!res.archive.error.includes(blockerRoot), 'no folder paths on screen');
  const status = await warned;
  assert.equal(status.failing.length, 1);
  assert.equal(status.failing[0].sessionId, session.id);
  // A reloaded pharmacy screen gets the same warning.
  assert.deepEqual((await getJson('/api/archive/status')).body.failing.map((f) => f.sessionId), [session.id]);

  // Nothing lost: the session is closed with every prescription intact.
  const row = db.prepare('SELECT status, archive_file FROM sessions WHERE id = ?').get(session.id);
  assert.deepEqual(row, { status: 'closed', archive_file: null });
  const rows = prescriptionRows(db, session.id);
  assert.deepEqual(rows.map((r) => r.id), prescriptions.map((rx) => rx.id).sort());

  // It keeps retrying with backoff while the folder is broken…
  await new Promise((r) => setTimeout(r, 500));
  const stillFailing = (await getJson('/api/archive/status')).body.failing[0];
  assert.ok(stillFailing.attempts >= 2, `attempts: ${stillFailing.attempts}`);

  // …and once the folder can be created, the next retry archives it and
  // the warning clears.
  const cleared = new Promise((resolve) =>
    pharmacy.on('archive:status', (s) => s.failing.length === 0 && resolve(s))
  );
  fs.rmSync(blocker);
  await cleared;
  const archived = db.prepare('SELECT archive_file FROM sessions WHERE id = ?').get(session.id).archive_file;
  assert.equal(archived, `${localDate()}_session-${session.id}.pdf`);
  const text = await pdfText(path.join(archiveDir, archived));
  for (const rx of prescriptions) assert.match(text, new RegExp(rx.id));
  assert.deepEqual((await getJson('/api/archive/status')).body, { failing: [] });
  assert.equal(prescriptionRows(db, session.id).length, 3);
});

test('archive status needs a login', async (t) => {
  const { getJson } = await startTestServer(t);
  assert.equal((await getJson('/api/archive/status', { cookie: '' })).status, 401);
  assert.equal((await getJson('/api/archive/status', { role: 'doctor' })).status, 200);
});
