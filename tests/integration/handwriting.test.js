'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer, nextEvent, noEvent } = require('./server-harness');
const { ERRORS } = require('../../src/validation');
const { MAX_IMAGE_BYTES } = require('../../src/png');
const { fakeHandwritten, fakeTyped, makePng } = require('../helpers');

const ACK_MS = 3000;

async function setup(t) {
  const harness = await startTestServer(t);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  return { ...harness, doctor, pharmacy };
}

// GET as the pharmacy (logged in).
async function getBytes({ base, cookieFor }, url) {
  const res = await fetch(`${base}${url}`, { headers: { cookie: await cookieFor('pharmacy') } });
  return { status: res.status, type: res.headers.get('content-type'), headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

function imageFiles(dataDir) {
  const dir = path.join(dataDir, 'images');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test('a handwritten PNG round-trips byte-for-byte', async (t) => {
  const { base, cookieFor, getJson, db, dataDir, doctor, pharmacy } = await setup(t);
  const image = makePng({ width: 300, height: 200 });

  const received = nextEvent(pharmacy, 'prescription:new', 1000);
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeHandwritten({ image }));
  assert.equal(res.ok, true, res.error);
  const rx = res.prescription;
  assert.equal(rx.kind, 'handwritten');
  assert.deepEqual(rx.lines, []);
  assert.equal(rx.imageUrl, `/api/prescriptions/${rx.id}/image`);

  // The broadcast carries the URL, not the image bytes or the file path.
  assert.deepEqual(await received, rx);
  assert.ok(!JSON.stringify(rx).includes(dataDir.replace(/\\/g, '\\\\')));

  // Stored at DATA_DIR/images/<id>.png, path in the database, bytes unchanged.
  const row = db.prepare('SELECT image_path, typed_body FROM prescriptions WHERE id = ?').get(rx.id);
  assert.equal(row.image_path, `images/${rx.id}.png`);
  assert.equal(row.typed_body, null);
  assert.ok(fs.readFileSync(path.join(dataDir, 'images', `${rx.id}.png`)).equals(image));
  assert.deepEqual(imageFiles(dataDir), [`${rx.id}.png`], 'no temp file left behind');

  // Served unchanged as image/png.
  const served = await getBytes({ base, cookieFor }, rx.imageUrl);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(served.body.equals(image), 'served bytes match the bytes sent');

  // The queue REST call lists it too.
  const list = (await getJson(`/api/prescriptions?session=${rx.sessionId}`)).body;
  assert.deepEqual(list.prescriptions, [rx]);
});

test('the PNG and the row are saved when the ack and the broadcast arrive', async (t) => {
  const { db, dataDir, doctor, pharmacy } = await setup(t);
  const find = db.prepare('SELECT id FROM prescriptions WHERE id = ?');
  const fileFor = (id) => path.join(dataDir, 'images', `${id}.png`);

  let atBroadcast;
  pharmacy.once('prescription:new', (rx) => (atBroadcast = { row: find.get(rx.id), file: fs.existsSync(fileFor(rx.id)) }));
  const atAck = await new Promise((resolve) => {
    doctor.emit('prescription:new', fakeHandwritten(), (res) =>
      resolve({ row: find.get(res.prescription.id), file: fs.existsSync(fileFor(res.prescription.id)) })
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(atAck.row && atAck.file, 'saved before ack');
  assert.ok(atBroadcast.row && atBroadcast.file, 'saved before broadcast');
});

test('rejects an empty canvas, a non-PNG and an oversized drawing; nothing is saved', async (t) => {
  const { db, dataDir, doctor, pharmacy } = await setup(t);
  const cases = [
    [makePng({ blank: true }), ERRORS.noDrawing],
    [null, ERRORS.noDrawing],
    [Buffer.from('GIF89a not a png'), ERRORS.imageInvalid],
    [Buffer.concat([makePng(), Buffer.alloc(MAX_IMAGE_BYTES)]), ERRORS.imageTooLarge]
  ];
  const quiet = noEvent(pharmacy, 'prescription:new', 500);
  for (const [image, error] of cases) {
    const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeHandwritten({ image }));
    assert.deepEqual(res, { ok: false, error });
  }
  assert.equal(await quiet, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n, 0);
  assert.deepEqual(imageFiles(dataDir), []);
});

test('rejects a handwritten prescription with no patient ref', async (t) => {
  const { doctor } = await setup(t);
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeHandwritten({ patientRef: ' ' }));
  assert.deepEqual(res, { ok: false, error: ERRORS.patientRef });
});

test('if the database insert fails, no image file is left behind', async (t) => {
  const { db, dataDir, doctor, pharmacy } = await setup(t);
  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON prescriptions
           BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
  const quiet = noEvent(pharmacy, 'prescription:new');
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeHandwritten());
  assert.equal(res.ok, false);
  assert.match(res.error, /NOT saved/);
  assert.equal(await quiet, true);
  assert.deepEqual(imageFiles(dataDir), []);
});

test('the image route returns 404 for unknown, typed and malformed IDs', async (t) => {
  const { base, cookieFor, doctor } = await setup(t);
  const typed = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  assert.equal(typed.prescription.imageUrl, null);
  for (const id of [typed.prescription.id, 'RX-20260101-9999', 'not-an-id', '..%2F..%2Fe-prescription.db']) {
    const res = await getBytes({ base, cookieFor }, `/api/prescriptions/${id}/image`);
    assert.equal(res.status, 404, id);
    assert.notEqual(res.type, 'image/png');
  }
});
