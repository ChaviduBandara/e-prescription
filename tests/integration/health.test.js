'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./server-harness');

test('GET /health returns 200 with status ok', async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('browser libraries are served locally from /vendor/', async (t) => {
  const { base } = await startTestServer(t);
  for (const file of ['socket.io.min.js', 'signature_pad.umd.min.js']) {
    const res = await fetch(`${base}/vendor/${file}`);
    assert.equal(res.status, 200, `${file} should be served`);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});
