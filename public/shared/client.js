// Helpers shared by the doctor and pharmacy screens.
// All text goes in through textContent, never innerHTML.

// el('p', { className: 'x' }, 'text', childNode)
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function sessionLabel(session) {
  return session ? `Session ${session.id} · started ${formatTime(session.startedAt)}` : '';
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// Current open session and its prescriptions (arrival order).
export async function fetchState() {
  const { session } = await getJson('/api/session/current');
  if (!session) return { session: null, prescriptions: [] };
  const { prescriptions } = await getJson(`/api/prescriptions?session=${session.id}`);
  return { session, prescriptions };
}

// Prescriptions keyed by ID, so a broadcast and a reload never duplicate.
export class PrescriptionStore {
  constructor() {
    this.sessionId = null;
    this.byId = new Map();
  }
  // Loads a fetched list. Same session: merge, so a broadcast that arrived
  // while the fetch was in flight is kept. New session: start over.
  sync(sessionId, list = []) {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.byId = new Map();
    }
    for (const rx of list) this.byId.set(rx.id, rx);
  }
  has(id) {
    return this.byId.has(id);
  }
  upsert(rx) {
    const isNew = !this.byId.has(rx.id);
    this.byId.set(rx.id, rx);
    return isNew;
  }
  // Oldest first.
  list() {
    return [...this.byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }
}

// The server refused the login: reload, which shows the PIN screen. Only
// if the server agrees we are logged out, so this can never loop.
async function backToPinScreen(socket, role) {
  try {
    const res = await fetch(`/api/auth/check?role=${role}`, { cache: 'no-store' });
    if (res.ok && (await res.json()).ok === false) {
      socket.disconnect();
      window.location.reload();
    }
  } catch {
    // Server unreachable: Socket.IO keeps retrying.
  }
}

// Connects Socket.IO and reloads state on every (re)connect.
// `io` is the global from /vendor/socket.io.min.js.
// socket.reload() fetches state again; it resolves after onState has run.
// `statusEl` shows Connected / Reconnecting…; `bannerEl` (optional) is shown
// while the connection is down. Socket.IO keeps retrying on its own.
// `role` is this screen's role; the server checks it against the login
// cookie. If the login has expired the page reloads to its PIN screen.
export function connectSocket({ role, statusEl, bannerEl, onState, onLoadError }) {
  const socket = window.io({
    transports: ['websocket', 'polling'],
    auth: { role },
    // On the LAN a connect takes milliseconds. One that hangs (e.g. while
    // the tablet's WiFi reconnects) is dropped after 5 s and tried again,
    // instead of the default 20 s.
    timeout: 5000
  });

  function setStatus(online) {
    statusEl.textContent = online ? 'Connected' : 'Reconnecting…';
    statusEl.classList.toggle('conn--online', online);
    statusEl.classList.toggle('conn--offline', !online);
    if (bannerEl) bannerEl.hidden = online;
  }

  // Reloads can overlap (a quick drop and reconnect); only the newest one's
  // answer is used, so an older, slower reply never undoes a newer state.
  let loads = 0;
  socket.reload = async () => {
    const mine = ++loads;
    try {
      const state = await fetchState();
      if (mine === loads) onState(state);
    } catch (err) {
      if (mine === loads) onLoadError(err);
    }
  };

  socket.on('connect', () => {
    setStatus(true);
    socket.reload();
  });
  socket.on('disconnect', () => setStatus(false));
  socket.on('connect_error', async (err) => {
    setStatus(false);
    if (err && err.message === 'unauthorized') await backToPinScreen(socket, role);
  });
  return socket;
}
