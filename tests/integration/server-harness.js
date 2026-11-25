// Starts the real server on a free port with a temp DATA_DIR, and opens
// Socket.IO clients that play the doctor and the pharmacy.
'use strict';

const { io } = require('socket.io-client');
const { start } = require('../../server');
const { makeTempDir, removeDir } = require('../helpers');

// Fake PINs for tests only.
const PINS = { doctor: '1111', pharmacy: '2222' };

async function startTestServer(t, { authOptions } = {}) {
  const dataDir = makeTempDir();
  const server = await start({ port: 0, dataDir, pins: PINS, authOptions });
  const base = `http://localhost:${server.port}`;
  const clients = [];

  // One hook, in order: clients, server + database, then the folder.
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    removeDir(dataDir);
  });

  // POST /api/auth/login. Returns { status, body, cookie } (cookie is the
  // "name=value" pair to send back, or null).
  async function login(role, pin = PINS[role]) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, pin })
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json(), setCookie, cookie: setCookie && setCookie.split(';')[0] };
  }

  const cookies = {};
  async function cookieFor(role) {
    if (!cookies[role]) cookies[role] = (await login(role)).cookie;
    return cookies[role];
  }

  // Opens a socket for `role`, logged in, unless options say otherwise:
  // { cookie } sends that cookie instead ('' for none); { claim } is the
  // role named in the handshake (defaults to `role`; null names none).
  function rawConnect(role, { cookie, claim = role, origin } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const socket = io(base, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: claim === null ? {} : { role: claim },
      extraHeaders: headers
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  async function connect(role, options = {}) {
    if (role !== 'doctor' && role !== 'pharmacy') throw new Error(`connect(role): unknown role ${role}`);
    const cookie = 'cookie' in options ? options.cookie : await cookieFor(role);
    return rawConnect(role, { ...options, cookie });
  }

  // GET as `role` (default pharmacy); { cookie } overrides ('' for none).
  async function getJson(path, { role = 'pharmacy', cookie } = {}) {
    const sent = cookie === undefined ? await cookieFor(role) : cookie;
    const res = await fetch(`${base}${path}`, { headers: sent ? { cookie: sent } : {} });
    return { status: res.status, body: await res.json() };
  }

  return { server, db: server.db, base, dataDir, connect, getJson, login, cookieFor, PINS };
}

// Resolves with the next `event` on `socket`, or rejects after `ms`.
function nextEvent(socket, event, ms = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Resolves true if `event` does NOT arrive on `socket` within `ms`.
function noEvent(socket, event, ms = 300) {
  return new Promise((resolve) => {
    const handler = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, ms);
    socket.once(event, handler);
  });
}

module.exports = { startTestServer, nextEvent, noEvent, PINS };
