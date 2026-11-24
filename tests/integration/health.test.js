'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../../server');

async function startServer(t) {
  const server = start(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://localhost:${server.address().port}`;
}

test('GET /health returns 200 with status ok', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('browser libraries are served locally from /vendor/', async (t) => {
  const base = await startServer(t);
  for (const file of ['socket.io.min.js', 'signature_pad.umd.min.js']) {
    const res = await fetch(`${base}/vendor/${file}`);
    assert.equal(res.status, 200, `${file} should be served`);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});
