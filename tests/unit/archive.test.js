'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { buildSessionPdf, archiveFileName, writeAtomically, createArchiver, archiveSession } = require('../../src/archive');
const { startSession, endSession } = require('../../src/sessions');
const { createTypedPrescription } = require('../../src/prescriptions');
const { tempDir, tempDb, fakeTyped } = require('../helpers');

const SESSION = { id: 7, startedAt: '2026-01-02T08:30:00.000Z', endedAt: '2026-01-02T12:00:00.000Z' };

async function pdfInfo(bytes) {
  const parser = new PDFParse({ data: bytes });
  try {
    const { text, total } = await parser.getText();
    return { text, pages: total };
  } finally {
    await parser.destroy();
  }
}

function typedRx(n) {
  return {
    id: `RX-20260102-${String(n).padStart(4, '0')}`,
    patientRef: `TOKEN-${String(n).padStart(3, '0')}`,
    kind: 'typed',
    lines: [{ medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily after meals' }],
    status: 'sent',
    createdAt: '2026-01-02T09:00:00.000Z',
    dispensedAt: null
  };
}

test('the file name is YYYY-MM-DD_session-<id>.pdf from the local start date', () => {
  const d = new Date(SESSION.startedAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(archiveFileName(SESSION), `${date}_session-7.pdf`);
});

test('a long session flows over several pages, each numbered', async () => {
  const prescriptions = Array.from({ length: 40 }, (_, i) => typedRx(i + 1));
  const bytes = await buildSessionPdf({ session: SESSION, prescriptions, clinicName: 'Test Clinic', imageFileFor: () => null });
  const { text, pages } = await pdfInfo(bytes);
  assert.ok(pages > 1, `pages: ${pages}`);
  assert.match(text, new RegExp(`Page 1 of ${pages}`));
  assert.match(text, new RegExp(`Page ${pages} of ${pages}`));
  for (const rx of prescriptions) assert.match(text, new RegExp(rx.id));
});

test('an empty session and a missing handwriting image are stated, not dropped', async () => {
  const empty = await pdfInfo(await buildSessionPdf({ session: SESSION, prescriptions: [], clinicName: 'Test Clinic', imageFileFor: () => null }));
  assert.match(empty.text, /No prescriptions in this session/);

  const drawn = { ...typedRx(1), kind: 'handwritten', lines: [] };
  const missing = await pdfInfo(
    await buildSessionPdf({ session: SESSION, prescriptions: [drawn], clinicName: 'Test Clinic', imageFileFor: () => '/no/such/file.png' })
  );
  assert.match(missing.text, /Handwriting image missing/);
  assert.match(missing.text, new RegExp(drawn.id));
});

test('writeAtomically leaves no temp file and never overwrites an existing archive', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'archive');
  assert.equal(writeAtomically(dir, 'a.pdf', Buffer.from('first')), 'a.pdf');
  assert.equal(writeAtomically(dir, 'a.pdf', Buffer.from('second')), 'a_2.pdf');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.pdf', 'a_2.pdf']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.pdf'), 'utf8'), 'first');
});

test('archiveSession records the file once and never touches prescriptions', async (t) => {
  const { db, dir } = tempDb(t);
  const { session } = startSession(db);
  createTypedPrescription(db, fakeTyped());
  endSession(db, session.id);
  const before = db.prepare('SELECT * FROM prescriptions').all();
  const options = { dataDir: dir, archiveDir: path.join(dir, 'archive'), clinicName: 'Test Clinic' };

  const archived = await archiveSession(db, options, session.id);
  assert.ok(archived.archiveFile);
  assert.ok(archived.archivedAt);
  const again = await archiveSession(db, options, session.id);
  assert.equal(again.archiveFile, archived.archiveFile);
  assert.equal(fs.readdirSync(options.archiveDir).length, 1, 'archiving twice writes once');
  assert.deepEqual(db.prepare('SELECT * FROM prescriptions').all(), before);
});

test('the archiver retries with doubling delays, reports status, and archivePending catches up', async (t) => {
  const { db, dir } = tempDb(t);
  const { session } = startSession(db);
  createTypedPrescription(db, fakeTyped());
  endSession(db, session.id);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const changes = [];
  const archiver = createArchiver(
    db,
    { dataDir: dir, archiveDir: path.join(blocker, 'archive'), clinicName: 'Test Clinic' },
    { onChange: (s) => changes.push(s), firstDelayMs: 60_000, maxDelayMs: 600_000 }
  );
  t.after(() => archiver.close());

  // Closed but never archived (as after a crash): archivePending finds it.
  const [first] = await archiver.archivePending();
  assert.equal(first.ok, false);
  let [entry] = archiver.status().failing;
  assert.equal(entry.sessionId, session.id);
  assert.equal(entry.attempts, 1);
  const delay1 = Date.parse(entry.nextRetryAt) - Date.now();
  assert.ok(delay1 > 55_000 && delay1 <= 60_000, String(delay1));

  await archiver.archive(session.id); // a manual retry, still failing
  [entry] = archiver.status().failing;
  assert.equal(entry.attempts, 2);
  const delay2 = Date.parse(entry.nextRetryAt) - Date.now();
  assert.ok(delay2 > 115_000 && delay2 <= 120_000, String(delay2));

  fs.rmSync(blocker);
  const ok = await archiver.archive(session.id);
  assert.equal(ok.ok, true);
  assert.deepEqual(archiver.status(), { failing: [] });
  assert.deepEqual(changes.at(-1), { failing: [] });
  assert.deepEqual(await archiver.archivePending(), [], 'nothing left to archive');
});

test('a handwriting image starts on the same page as its ID and patient', async (t) => {
  const { makePng } = require('../helpers');
  const dir = tempDir(t);
  const file = path.join(dir, 'drawn.png');
  fs.writeFileSync(file, makePng({ width: 984, height: 1260 })); // tablet-sized
  const drawn = { ...typedRx(2), kind: 'handwritten', lines: [] };
  const bytes = await buildSessionPdf({
    session: SESSION,
    prescriptions: [typedRx(1), drawn, typedRx(3)],
    clinicName: 'Test Clinic',
    imageFileFor: (rx) => (rx.id === drawn.id ? file : null)
  });
  const parser = new PDFParse({ data: bytes });
  try {
    const images = (await parser.getImage()).pages.filter((p) => p.images.length);
    assert.equal(images.length, 1);
    const pageNumber = images[0].pageNumber;
    const pageText = (await parser.getText({ partial: [pageNumber] })).text;
    assert.match(pageText, new RegExp(drawn.id), `page ${pageNumber} has the drawing and its ID`);
    assert.match(pageText, new RegExp(drawn.patientRef));
  } finally {
    await parser.destroy();
  }
});
