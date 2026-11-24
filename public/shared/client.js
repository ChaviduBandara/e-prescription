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

// Connects Socket.IO and reloads state on every (re)connect.
// `io` is the global from /vendor/socket.io.min.js.
// socket.reload() fetches state again; it resolves after onState has run.
export function connectSocket({ statusEl, onState, onLoadError }) {
  const socket = window.io({ transports: ['websocket', 'polling'] });

  function setStatus(online) {
    statusEl.textContent = online ? 'Connected' : 'Offline';
    statusEl.classList.toggle('conn--online', online);
    statusEl.classList.toggle('conn--offline', !online);
  }

  socket.reload = async () => {
    try {
      onState(await fetchState());
    } catch (err) {
      onLoadError(err);
    }
  };

  socket.on('connect', () => {
    setStatus(true);
    socket.reload();
  });
  socket.on('disconnect', () => setStatus(false));
  socket.on('connect_error', () => setStatus(false));
  return socket;
}
