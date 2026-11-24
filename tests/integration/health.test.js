'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../../server');

test('GET /health returns 200 with status ok', async (t) => {
  const server = start(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://localhost:${port}/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'ok');
});
