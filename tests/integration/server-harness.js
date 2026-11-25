// Starts the real server on a free port with a temp DATA_DIR, and opens
// Socket.IO clients that play the doctor and the pharmacy.
'use strict';

const { io } = require('socket.io-client');
const { start } = require('../../server');
const { makeTempDir, removeDir } = require('../helpers');

async function startTestServer(t) {
  const dataDir = makeTempDir();
  const server = await start({ port: 0, dataDir });
  const base = `http://localhost:${server.port}`;
  const clients = [];

  // One hook, in order: clients, server + database, then the folder.
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    removeDir(dataDir);
  });

  async function connect() {
    const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }

  async function getJson(path) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  }

  return { server, db: server.db, base, dataDir, connect, getJson };
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

module.exports = { startTestServer, nextEvent, noEvent };
