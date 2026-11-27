// Archives a closed session as one dated PDF in ARCHIVE_DIR (a Google Drive
// for Desktop sync folder in production).
//
// - The PDF is written to a hidden temp file in the same folder, flushed to
//   disk, then renamed, so Drive never syncs a half-written file.
// - If writing fails the session stays closed and the archiver retries with
//   backoff, reporting the failure so the pharmacy screen can warn.
// - Archiving only adds a file and two columns. It never deletes or changes
//   a prescription (hard rule 4).
// - Handwriting goes in as the PNG exactly as drawn, never as text (rule 1).
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getSession } = require('./sessions');
const { listForSession, getImageFile } = require('./prescriptions');
const { setUpFonts, textRuns, writeRich, heightOf, UNPRINTABLE_COLOR } = require('./pdf-text');

const MARGIN = 50;
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// ---- Formatting (server local time: the pharmacy PC's clock) ---------------

const pad2 = (n) => String(n).padStart(2, '0');
function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const localDateTime = (iso) => (iso ? `${localDate(iso)} ${localTime(iso)}` : '');

// YYYY-MM-DD_session-<id>.pdf, dated by when the session started.
function archiveFileName(session) {
  return `${localDate(session.startedAt)}_session-${session.id}.pdf`;
}

// ---- PDF -------------------------------------------------------------------

// Resolves with the PDF bytes for `session` and its prescriptions.
function buildSessionPdf({ session, prescriptions, clinicName, imageFileFor }) {
  return new Promise((resolve, reject) => {
    // Dated by the session, not the clock, so the same session always makes
    // the same bytes (pdfkit derives the file ID from this info). After a
    // crash, a rebuilt PDF then matches the one already written.
    const dated = new Date(session.endedAt || session.startedAt);
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true, // for "Page n of m"
      info: {
        Title: `Session ${session.id} — ${localDate(session.startedAt)}`,
        Author: clinicName,
        CreationDate: dated,
        ModDate: dated
      }
    });
    const fonts = setUpFonts(doc);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      writeHeader(doc, fonts, session, prescriptions, clinicName);
      prescriptions.forEach((rx, i) => writePrescription(doc, fonts, rx, i + 1, imageFileFor(rx)));
      if (prescriptions.length === 0) doc.font('Helvetica-Oblique').text('No prescriptions in this session.');
      writeFooters(doc, session);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const width = (doc) => doc.page.width - MARGIN * 2;
const bottom = (doc) => doc.page.height - MARGIN - 20; // room for the footer

function ensureSpace(doc, height) {
  if (doc.y + height > bottom(doc)) doc.addPage();
}

function writeHeader(doc, fonts, session, prescriptions, clinicName) {
  const name = textRuns(fonts, clinicName, { bold: true });
  writeRich(doc, name.runs, MARGIN, doc.y, { size: 18, width: width(doc) });
  writeMissing(doc, name.missing, 'the clinic name (CLINIC_NAME)');
  doc.font('Helvetica').fontSize(12).fillColor('#333333');
  doc.text(`Prescriptions — Session ${session.id}`);
  const ended = session.endedAt ? localDateTime(session.endedAt) : 'still open';
  doc.text(`${localDateTime(session.startedAt)} to ${ended}`);
  const dispensed = prescriptions.filter((rx) => rx.status === 'dispensed').length;
  doc.text(`${prescriptions.length} prescription${prescriptions.length === 1 ? '' : 's'}, ${dispensed} dispensed`);
  doc.fillColor('black');
  rule(doc);
}

function rule(doc) {
  doc.moveDown(0.5);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width(doc), doc.y).lineWidth(0.5).strokeColor('#999999').stroke();
  doc.moveDown(0.8);
}

const HEADING_HEIGHT = 45; // ID line + times line + gap
const CAPTION_HEIGHT = 20;

function writePrescription(doc, fonts, rx, number, imageFile) {
  const image = rx.kind === 'handwritten' ? openImage(doc, imageFile) : null;
  const size = image && imageSize(doc, image);
  // A drawing always starts on the same page as its ID and patient, so a
  // printed page never shows handwriting without saying whose it is.
  ensureSpace(doc, HEADING_HEIGHT + (size ? size.height + CAPTION_HEIGHT : 45));
  // One paragraph: "1. RX-… (bold)   Patient: " then the ref in its own
  // script, all on one baseline.
  const ref = textRuns(fonts, rx.patientRef);
  const heading = [
    { font: 'Helvetica-Bold', text: `${number}. ${rx.id}` },
    { font: 'Helvetica', text: '   Patient: ' },
    ...ref.runs
  ];
  writeRich(doc, heading, MARGIN, doc.y, { size: 13, width: width(doc) });
  const missing = [...ref.missing];
  doc.fontSize(10).fillColor('#333333');
  const dispensed = rx.dispensedAt ? localDateTime(rx.dispensedAt) : 'Not dispensed';
  doc.text(`Sent: ${localDateTime(rx.createdAt)}    Dispensed: ${dispensed}`);
  doc.fillColor('black').moveDown(0.5);

  if (rx.kind === 'handwritten') writeHandwriting(doc, image, size);
  else missing.push(...writeLines(doc, fonts, rx.lines));
  writeMissing(doc, missing, rx.id);
  rule(doc);
}

// Says, in red, which characters could not be printed (shown as "?"), so a
// reader knows to check the original instead of trusting the paper.
function writeMissing(doc, missing, where) {
  if (missing.length === 0) return;
  const list = [...new Set(missing)].join(', ');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(UNPRINTABLE_COLOR);
  doc.text(`Some characters could not be printed (shown as ?): ${list}. Check ${where} in the e-Prescription system.`, MARGIN, doc.y, {
    width: width(doc)
  });
  doc.fillColor('black');
}

// Columns: Medicine 40%, Dosage 20%, Instructions 40%, matching the screen.
// Returns the characters that could not be printed.
function writeLines(doc, fonts, lines) {
  const w = width(doc);
  const cols = [
    { key: 'medicine', title: 'Medicine', width: w * 0.4 },
    { key: 'dosage', title: 'Dosage', width: w * 0.2 },
    { key: 'instructions', title: 'Instructions', width: w * 0.4 }
  ];
  const missing = [];
  const row = (cells, bold) => {
    const texts = cells.map((cell) => textRuns(fonts, cell || '-', { bold }));
    texts.forEach((t) => missing.push(...t.missing));
    const height = Math.max(...texts.map((t, i) => heightOf(doc, t.runs, { size: 10.5, width: cols[i].width - 8 })));
    ensureSpace(doc, height + 4);
    const top = doc.y;
    let x = MARGIN;
    let end = top + height;
    texts.forEach((t, i) => {
      writeRich(doc, t.runs, x, top, { size: 10.5, width: cols[i].width - 8 });
      end = Math.max(end, doc.y);
      x += cols[i].width;
    });
    doc.x = MARGIN;
    doc.y = end + 4;
  };
  row(cols.map((c) => c.title), true);
  for (const line of lines) row(cols.map((c) => line[c.key]), false);
  return missing;
}

function openImage(doc, imageFile) {
  try {
    return imageFile ? doc.openImage(imageFile) : null;
  } catch {
    return null;
  }
}

// Scaled to the page width (never stretched), and smaller if needed so the
// heading, the drawing and its caption fit on one page.
function imageSize(doc, image) {
  const maxWidth = width(doc);
  const maxHeight = bottom(doc) - MARGIN - HEADING_HEIGHT - CAPTION_HEIGHT;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

// The PNG exactly as drawn.
function writeHandwriting(doc, image, size) {
  if (!image) {
    // Never silently drop it: say so in red where the drawing should be.
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#b42318');
    doc.text('Handwriting image missing from the data folder. Check the backup.');
    doc.fillColor('black');
    return;
  }
  const top = doc.y;
  doc.rect(MARGIN, top, size.width, size.height).lineWidth(0.5).strokeColor('#cccccc').stroke();
  doc.image(image, MARGIN, top, { width: size.width, height: size.height });
  doc.x = MARGIN;
  doc.y = top + size.height + 6;
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666666').text('Handwritten by the doctor. Image as drawn; not converted to text.');
  doc.fillColor('black');
}

function writeFooters(doc, session) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - MARGIN + 10;
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    // A zero bottom margin while writing the footer stops pdfkit adding a page.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.text(`Session ${session.id} · ${localDate(session.startedAt)} · Page ${i + 1} of ${count}`, MARGIN, y, {
      width: width(doc),
      align: 'center',
      lineBreak: false
    });
    doc.page.margins.bottom = saved;
  }
  doc.fillColor('black');
}

// ---- Writing the file ------------------------------------------------------

// Writes `bytes` to dir/name via a hidden temp file + fsync + rename.
// Never overwrites a different file of the same name (e.g. an archive from
// an older database): that one gets a _2, _3 … suffix instead. A file that
// already holds exactly these bytes (written just before a crash, not yet
// recorded) is reused as it is, so a crash never leaves a duplicate.
function writeAtomically(dir, name, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) {
    if (sameBytes(target, bytes)) return path.basename(target);
    target = path.join(dir, name.replace(/\.pdf$/, `_${n}.pdf`));
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.partial`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return path.basename(target);
}

function sameBytes(file, bytes) {
  try {
    return fs.statSync(file).size === bytes.length && fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

// Builds and writes the PDF for a closed session, then records it.
// Returns the updated session. Already archived: returns it unchanged.
async function archiveSession(db, { dataDir, archiveDir, clinicName }, sessionId, now = () => new Date()) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.archiveFile) return session;
  const prescriptions = listForSession(db, sessionId);
  const bytes = await buildSessionPdf({
    session,
    prescriptions,
    clinicName,
    imageFileFor: (rx) => (rx.kind === 'handwritten' ? getImageFile(db, dataDir, rx.id) : null)
  });
  const file = writeAtomically(archiveDir, archiveFileName(session), bytes);
  db.prepare('UPDATE sessions SET archive_file = ?, archived_at = ? WHERE id = ?').run(file, now().toISOString(), sessionId);
  return getSession(db, sessionId);
}

// ---- Retries ---------------------------------------------------------------

// Archives sessions, retrying failures with backoff until they succeed.
// onChange(status) runs whenever the list of failing sessions changes.
function createArchiver(db, options, { onChange = () => {}, firstDelayMs = RETRY_FIRST_MS, maxDelayMs = RETRY_MAX_MS } = {}) {
  const failing = new Map(); // sessionId -> { error, attempts, timer, nextRetryAt }
  const running = new Set(); // attempts in progress, so shutdown can wait
  let closed = false;

  function status() {
    return {
      failing: [...failing.entries()].map(([sessionId, f]) => ({
        sessionId,
        error: f.error,
        attempts: f.attempts,
        nextRetryAt: f.nextRetryAt
      }))
    };
  }

  // One attempt now. Resolves { ok: true, session } or { ok: false, error };
  // on failure a retry is already scheduled.
  function archive(sessionId) {
    const attempt = attemptArchive(sessionId);
    running.add(attempt);
    attempt.finally(() => running.delete(attempt));
    return attempt;
  }

  async function attemptArchive(sessionId) {
    const entry = failing.get(sessionId);
    if (entry) clearTimeout(entry.timer);
    try {
      const session = await archiveSession(db, options, sessionId);
      if (failing.delete(sessionId)) onChange(status());
      console.log(`archived session ${sessionId} as ${session.archiveFile}`);
      return { ok: true, session };
    } catch (err) {
      const attempts = (entry ? entry.attempts : 0) + 1;
      const delay = Math.min(firstDelayMs * 2 ** (attempts - 1), maxDelayMs);
      const error = describe(err);
      console.error(`archive of session ${sessionId} failed (attempt ${attempts}): ${err.message}`);
      const next = { error, attempts, nextRetryAt: new Date(Date.now() + delay).toISOString(), timer: null };
      if (!closed) {
        next.timer = setTimeout(() => archive(sessionId), delay);
        next.timer.unref();
      }
      failing.set(sessionId, next);
      onChange(status());
      return { ok: false, error };
    }
  }

  // Closed sessions with no PDF yet, e.g. the server stopped mid-archive.
  function archivePending() {
    const rows = db.prepare(`SELECT id FROM sessions WHERE status = 'closed' AND archive_file IS NULL ORDER BY id`).all();
    return Promise.all(rows.map((r) => archive(r.id)));
  }

  // Stops future retries. idle() resolves once attempts in progress finish.
  function close() {
    closed = true;
    for (const f of failing.values()) clearTimeout(f.timer);
  }

  function idle() {
    return Promise.allSettled([...running]);
  }

  return { archive, archivePending, status, close, idle };
}

// Temp files left by a PDF write that was cut short (crash, power cut). They
// are never a finished archive, and Drive would sync them, so they go.
const PARTIAL_PATTERN = /^\..+\.pdf\.\d+\.partial$/;

function removeStalePartials(archiveDir) {
  let names;
  try {
    names = fs.readdirSync(archiveDir);
  } catch {
    return []; // no folder yet, or not reachable: nothing to tidy
  }
  const removed = [];
  for (const name of names) {
    if (!PARTIAL_PATTERN.test(name) || name.endsWith(`.${process.pid}.partial`)) continue;
    try {
      fs.rmSync(path.join(archiveDir, name), { force: true });
      removed.push(name);
    } catch (err) {
      console.error(`could not remove stale archive temp file: ${err.code || err.message}`);
    }
  }
  return removed;
}

// A short reason for the pharmacy screen, without the folder path.
function describe(err) {
  const reasons = {
    EACCES: 'no permission to write to the archive folder',
    EPERM: 'no permission to write to the archive folder',
    ENOENT: 'the archive folder cannot be found',
    ENOTDIR: 'the archive folder path is not a folder',
    ENOSPC: 'the disk is full',
    EROFS: 'the archive folder is read-only',
    EBUSY: 'the archive file is in use'
  };
  return reasons[err.code] || 'the PDF could not be written';
}

module.exports = { buildSessionPdf, archiveSession, archiveFileName, createArchiver, writeAtomically, removeStalePartials };
