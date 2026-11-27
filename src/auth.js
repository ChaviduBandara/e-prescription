// Simple PIN login per role (doctor / pharmacy). No user accounts.
//
// A correct PIN gets a signed, httpOnly cookie for that role:
//   rx_<role> = <role>.<issuedAt ms>.<HMAC-SHA256>
// The HMAC key is the server secret plus the role's PIN, so changing a PIN
// logs that role out everywhere.
//
// Lockouts: 5 wrong PINs lock that role out for the client's IP for 1
// minute. Because a device on the WiFi can change its IP, 20 wrong PINs for
// one role within 10 minutes, from any IPs, lock that role out everywhere
// for 5 minutes. The per-IP table is pruned and capped so it cannot grow
// without limit.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = ['doctor', 'pharmacy'];
const LOGIN_MS = 24 * 60 * 60 * 1000; // a clinic day, with margin
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const ROLE_MAX_FAILURES = 20;
const ROLE_WINDOW_MS = 10 * 60 * 1000;
const ROLE_LOCKOUT_MS = 5 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 1000;
const MAX_PIN_LENGTH = 32;
const MIN_PIN_LENGTH = 4;
const PIN_ENV = { doctor: 'DOCTOR_PIN', pharmacy: 'PHARMACY_PIN' };

// Why these PINs are not safe to run with: [] if they are fine. Missing
// PINs would leave a screen open to anyone on the WiFi; equal PINs would let
// the doctor's PIN open the pharmacy screen too.
function pinProblems(pins = {}) {
  const problems = [];
  for (const role of ROLES) {
    const pin = pins[role];
    if (typeof pin !== 'string' || pin === '') problems.push(`${PIN_ENV[role]} is not set.`);
    else if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      problems.push(`${PIN_ENV[role]} must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters.`);
    }
  }
  if (!problems.length && pins.doctor === pins.pharmacy) problems.push('DOCTOR_PIN and PHARMACY_PIN must be different.');
  return problems;
}

const cookieName = (role) => `rx_${role}`;
const CLIENT_LOCKED = (s) => `Too many wrong PINs. Try again in ${s} seconds.`;
const ROLE_LOCKED = (s) => `Too many wrong PINs for this screen. Try again in ${s} seconds.`;

// The signing secret: SESSION_SECRET if set, else a random one kept in
// DATA_DIR so logins survive a server restart.
function loadSecret(dataDir, fromEnv) {
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    // Another process wrote it first: use theirs.
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw err;
  }
  return secret;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time string comparison.
function same(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Cookie header -> { name: value }. Only what we need; no decoding tricks.
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// pins: { doctor, pharmacy }. Options exist so tests can shorten time.
function createAuth({
  pins,
  secret,
  now = Date.now,
  lockoutMs = LOCKOUT_MS,
  loginMs = LOGIN_MS,
  roleMaxFailures = ROLE_MAX_FAILURES,
  roleWindowMs = ROLE_WINDOW_MS,
  roleLockoutMs = ROLE_LOCKOUT_MS,
  maxTrackedClients = MAX_TRACKED_CLIENTS
}) {
  const problems = pinProblems(pins);
  if (problems.length) throw new Error(`PIN setup: ${problems.join(' ')} Set them before starting the server (see README).`);
  // `${role}|${client}` -> { count, lockedUntil, last }, oldest-used first.
  const failures = new Map();
  // Per role, across all clients: recent failure times and the lock.
  const roleFailures = Object.fromEntries(ROLES.map((role) => [role, { times: [], lockedUntil: 0 }]));

  function sign(role, issuedAt) {
    return crypto
      .createHmac('sha256', `${secret}:${pins[role]}`)
      .update(`${role}.${issuedAt}`)
      .digest('base64url');
  }

  function issue(role) {
    const issuedAt = now();
    return `${role}.${issuedAt}.${sign(role, issuedAt)}`;
  }

  // True if `token` is a valid, unexpired login for `role`.
  function verify(role, token) {
    if (!ROLES.includes(role) || typeof token !== 'string') return false;
    const [tokenRole, issuedRaw, sig, extra] = token.split('.');
    if (extra !== undefined || tokenRole !== role || !/^\d{1,15}$/.test(issuedRaw || '')) return false;
    const issuedAt = Number(issuedRaw);
    const age = now() - issuedAt;
    if (age < 0 || age > loginMs) return false;
    return same(sig || '', sign(role, issuedAt));
  }

  // The roles (of `allowed`) that the request's cookies prove.
  function rolesFromCookieHeader(header, allowed = ROLES) {
    const cookies = parseCookies(header);
    return allowed.filter((role) => verify(role, cookies[cookieName(role)]));
  }

  // -> { ok: true, cookie } | { ok: false, status, error, retryAfter? }
  function login(role, pin, client) {
    if (!ROLES.includes(role)) return { ok: false, status: 400, error: 'Unknown screen.' };
    const t = now();
    prune(t);
    const roleState = roleFailures[role];
    if (roleState.lockedUntil > t) return lockedOut(roleState.lockedUntil, ROLE_LOCKED);
    const key = `${role}|${client}`;
    const entry = failures.get(key) || { count: 0, lockedUntil: 0, last: t };
    if (entry.lockedUntil > t) return lockedOut(entry.lockedUntil, CLIENT_LOCKED);

    const valid = typeof pin === 'string' && pin.length <= MAX_PIN_LENGTH && same(pin, pins[role]);
    if (valid) {
      failures.delete(key);
      return { ok: true, cookie: setCookieHeader(role, issue(role)) };
    }

    // Counted for the whole role first: many devices guessing together.
    roleState.times.push(t);
    if (roleState.times.length >= roleMaxFailures) {
      roleState.times = [];
      roleState.lockedUntil = t + roleLockoutMs;
      console.warn(`Too many wrong ${role} PINs: ${role} login locked for ${Math.round(roleLockoutMs / 1000)} s`);
      return lockedOut(roleState.lockedUntil, ROLE_LOCKED);
    }

    entry.count += 1;
    entry.last = t;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.count = 0;
      entry.lockedUntil = t + lockoutMs;
    }
    remember(key, entry);
    if (entry.lockedUntil > t) return lockedOut(entry.lockedUntil, CLIENT_LOCKED);
    const left = MAX_ATTEMPTS - entry.count;
    return { ok: false, status: 401, error: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` };
  }

  // Re-inserting keeps the Map in least-recently-used order, so when it is
  // full the client that has been quiet longest is forgotten first.
  function remember(key, entry) {
    failures.delete(key);
    failures.set(key, entry);
    while (failures.size > maxTrackedClients) failures.delete(failures.keys().next().value);
  }

  // Forgets old role failures and client entries that are idle and unlocked.
  function prune(t) {
    for (const state of Object.values(roleFailures)) state.times = state.times.filter((at) => t - at < roleWindowMs);
    for (const [key, entry] of failures) {
      if (entry.lockedUntil <= t && t - entry.last >= roleWindowMs) failures.delete(key);
    }
  }

  function lockedOut(until, message) {
    const retryAfter = Math.ceil((until - now()) / 1000);
    return { ok: false, status: 429, retryAfter, error: message(retryAfter) };
  }

  function setCookieHeader(role, token) {
    // httpOnly: page scripts cannot read it. SameSite=Strict: other sites
    // cannot use it. No Secure flag: the clinic LAN is plain http.
    return `${cookieName(role)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(loginMs / 1000)}`;
  }

  // For tests: how many clients the lockout table holds.
  const trackedClients = () => failures.size;

  return { login, verify, rolesFromCookieHeader, issue, trackedClients };
}

module.exports = {
  createAuth,
  loadSecret,
  parseCookies,
  cookieName,
  pinProblems,
  ROLES,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
  ROLE_MAX_FAILURES,
  ROLE_WINDOW_MS,
  ROLE_LOCKOUT_MS,
  MAX_TRACKED_CLIENTS
};
