'use strict';
// Queue — patient queue for a one-day free medical camp. See SPEC.md for the API contract.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 7 * 24 * 3600 * 1000;

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'queue.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL, age INTEGER NOT NULL, country TEXT NOT NULL, reason TEXT,
    status TEXT NOT NULL DEFAULT 'waiting',
    position REAL NOT NULL,
    client_id TEXT UNIQUE,
    created_at INTEGER NOT NULL, called_at INTEGER, done_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value);
  CREATE INDEX IF NOT EXISTS patients_status_position ON patients (status, position);
  INSERT OR IGNORE INTO meta (key, value) VALUES ('next_number', 1);
  INSERT OR IGNORE INTO meta (key, value) VALUES ('max_serving', 20);
`);

const COLS = 'id, number, name, age, country, reason, status, position, created_at, called_at, done_at';
const q = {
  byId: db.prepare(`SELECT ${COLS} FROM patients WHERE id = ?`),
  byNumber: db.prepare(`SELECT ${COLS} FROM patients WHERE number = ?`),
  byClient: db.prepare(`SELECT ${COLS} FROM patients WHERE client_id = ?`),
  ahead: db.prepare(`SELECT COUNT(*) AS n FROM patients WHERE status = 'waiting' AND position < ?`),
  maxPos: db.prepare(`SELECT MAX(position) AS p FROM patients WHERE status = 'waiting'`),
  minPos: db.prepare(`SELECT MIN(position) AS p FROM patients WHERE status = 'waiting' AND id != ?`),
  above: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'waiting' AND position < ? ORDER BY position DESC LIMIT 1`),
  below: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'waiting' AND position > ? ORDER BY position ASC LIMIT 1`),
  firstWaiting: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'waiting' ORDER BY position ASC LIMIT ?`),
  serving: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'serving' ORDER BY called_at ASC, id ASC`),
  waiting: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'waiting' ORDER BY position ASC`),
  done: db.prepare(`SELECT ${COLS} FROM patients WHERE status = 'done' ORDER BY done_at DESC, id DESC`),
  recent: db.prepare(`SELECT number, name FROM patients WHERE status = 'done' ORDER BY done_at DESC, id DESC LIMIT 6`),
  waitingCount: db.prepare(`SELECT COUNT(*) AS n FROM patients WHERE status = 'waiting'`),
  all: db.prepare(`SELECT ${COLS} FROM patients ORDER BY number ASC`),
  getNext: db.prepare(`SELECT value FROM meta WHERE key = 'next_number'`),
  setNext: db.prepare(`UPDATE meta SET value = ? WHERE key = 'next_number'`),
  getMax: db.prepare(`SELECT value FROM meta WHERE key = 'max_serving'`),
  setMax: db.prepare(`UPDATE meta SET value = ? WHERE key = 'max_serving'`),
  servingCount: db.prepare(`SELECT COUNT(*) AS n FROM patients WHERE status = 'serving'`),
  finishOldest: db.prepare(`UPDATE patients SET status = 'done', done_at = ? WHERE id IN
    (SELECT id FROM patients WHERE status = 'serving' ORDER BY called_at ASC, id ASC LIMIT ?)`),
  insert: db.prepare(`INSERT INTO patients (number, name, age, country, reason, status, position, client_id, created_at)
    VALUES (@number, @name, @age, @country, @reason, 'waiting', @position, @client_id, @created_at)`),
  update: db.prepare(`UPDATE patients SET name = @name, age = @age, country = @country, reason = @reason,
    status = @status, position = @position, called_at = @called_at, done_at = @done_at WHERE id = @id`),
  setPos: db.prepare(`UPDATE patients SET position = ? WHERE id = ?`),
  finishServing: db.prepare(`UPDATE patients SET status = 'done', done_at = ? WHERE status = 'serving'`),
  callOne: db.prepare(`UPDATE patients SET status = 'serving', called_at = ?, done_at = NULL WHERE id = ?`),
  del: db.prepare(`DELETE FROM patients WHERE id = ?`),
  delAll: db.prepare(`DELETE FROM patients`),
};

const ticketOf = (p) => ({ number: p.number, status: p.status, ahead: p.status === 'waiting' ? q.ahead.get(p.position).n : null });
const endPos = () => (q.maxPos.get().p ?? 0) + 1;
const MAX_SERVING_LIMIT = 30;
const maxServing = () => Number(q.getMax.get().value);
// Screen limit: before calling `slots` more people, finish the longest-serving ones so we never exceed it.
const makeRoom = (slots, now) => {
  const extra = q.servingCount.get().n + slots - maxServing();
  if (extra > 0) q.finishOldest.run(now, extra);
};

const createPatient = db.transaction((data, clientId) => {
  const number = Number(q.getNext.get().value);
  q.setNext.run(number + 1);
  const row = { ...data, number, position: endPos(), client_id: clientId || null, created_at: Date.now() };
  return q.byId.get(q.insert.run(row).lastInsertRowid);
});

const updatePatient = db.transaction((p, changes) => {
  const next = { ...p, ...changes };
  if (changes.status && changes.status !== p.status) {
    const now = Date.now();
    if (next.status === 'serving') { makeRoom(1, now); Object.assign(next, { called_at: now, done_at: null }); }
    else if (next.status === 'done') next.done_at = now;
    else Object.assign(next, { called_at: null, done_at: null, position: (q.minPos.get(p.id).p ?? 1) - 1 });
  }
  q.update.run(next);
  return q.byId.get(p.id);
});

const movePatient = db.transaction((p, to) => {
  if (to === 'top') q.setPos.run((q.minPos.get(p.id).p ?? p.position + 1) - 1, p.id);
  else if (to === 'bottom') q.setPos.run(endPos(), p.id);
  else {
    const other = (to === 'up' ? q.above : q.below).get(p.position);
    if (other) { q.setPos.run(other.position, p.id); q.setPos.run(p.position, other.id); }
  }
  return q.byId.get(p.id);
});

const callNext = db.transaction((count, finish) => {
  const now = Date.now();
  if (finish) q.finishServing.run(now);
  const toCall = q.firstWaiting.all(Math.min(count, maxServing()));
  makeRoom(toCall.length, now);
  return toCall.map((p) => { q.callOne.run(now, p.id); return q.byId.get(p.id); });
});

const resetAll = db.transaction(() => { q.delAll.run(); q.setNext.run(1); });

const getState = () => {
  const serving = q.serving.all(), waiting = q.waiting.all(), done = q.done.all();
  const counts = { waiting: waiting.length, serving: serving.length, done: done.length };
  return { serving, waiting, done, settings: { maxServing: maxServing() },
    counts: { ...counts, total: waiting.length + serving.length + done.length } };
};
const getDisplay = () => ({
  maxServing: maxServing(),
  serving: q.serving.all().slice(-maxServing()).map(({ number, name, called_at }) => ({ number, name, called_at })),
  waiting: q.waitingCount.get().n,
  recent: q.recent.all(),
});

// ---------- validation ----------
function validate(body, partial) {
  const out = {};
  const str = (key, label, min, max) => {
    const v = body[key];
    if (v === undefined && partial) return null;
    if (v != null && typeof v !== 'string') return `${label} must be text`;
    const s = (v || '').trim();
    if (s.length < min) return `${label} is required`;
    if (s.length > max) return `${label} must be at most ${max} characters`;
    out[key] = s || null;
    return null;
  };
  const err = str('name', 'Name', 1, 80) || str('country', 'Country', 1, 60) || str('reason', 'Reason', 0, 300);
  if (err) return { error: err };
  if (body.age !== undefined || !partial) {
    const age = toInt(body.age);
    if (age === null || age < 0 || age > 130) return { error: 'Age must be a whole number between 0 and 130' };
    out.age = age;
  }
  return { data: out };
}
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

// ---------- auth ----------
const sessionKey = crypto.createHash('sha256').update('queue-session:' + ADMIN_PASSWORD).digest();
const sign = (exp) => crypto.createHmac('sha256', sessionKey).update(String(exp)).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
function isAdmin(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  return Number(exp) > Date.now() && !!mac && safeEqual(mac, sign(exp));
}
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'login required' }));
const cookie = (req, value, maxAge) =>
  `sid=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

const loginFailures = new Map(); // ip -> {count, reset}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of loginFailures) if (f.reset <= now) loginFailures.delete(ip);
}, 60_000).unref();

// ---------- live updates (SSE) ----------
const clients = { admin: new Set(), display: new Set() };
let broadcastTimer = null;
const sseMessage = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
function flush() {
  broadcastTimer = null;
  if (clients.admin.size) { const m = sseMessage('state', getState()); for (const r of clients.admin) r.write(m); }
  if (clients.display.size) { const m = sseMessage('display', getDisplay()); for (const r of clients.display) r.write(m); }
}
const scheduleBroadcast = () => { if (!broadcastTimer) broadcastTimer = setTimeout(flush, 250); };
setInterval(() => { for (const set of Object.values(clients)) for (const r of set) r.write(': ping\n\n'); }, 25_000).unref();

function sse(set, event, payloadFn) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n' + sseMessage(event, payloadFn()));
    set.add(res);
    res.on('close', () => set.delete(res));
  };
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

const findPatient = (req, res) => {
  const p = /^\d+$/.test(req.params.id) ? q.byId.get(Number(req.params.id)) : undefined;
  if (!p) res.status(404).json({ error: 'Patient not found' });
  return p;
};

// public API
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.post('/api/checkin', (req, res) => {
  const body = req.body || {};
  const clientId = body.clientId == null || body.clientId === '' ? null : body.clientId;
  if (clientId !== null && (typeof clientId !== 'string' || clientId.length > 64)) {
    return res.status(400).json({ error: 'Invalid clientId' });
  }
  // Lookup + insert run synchronously (no await in between), so a repeated clientId can never create two tickets.
  const existing = clientId && q.byClient.get(clientId);
  if (existing) return res.status(200).json(ticketOf(existing));
  const v = validate(body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const patient = createPatient(v.data, clientId);
  scheduleBroadcast();
  res.status(201).json(ticketOf(patient));
});

app.get('/api/ticket/:number', (req, res) => {
  const p = /^\d+$/.test(req.params.number) ? q.byNumber.get(Number(req.params.number)) : undefined;
  if (!p) return res.status(404).json({ error: 'Ticket not found' });
  res.set('Cache-Control', 'no-store').json(ticketOf(p));
});

const checkinUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}/`;
app.get('/api/checkin-url', (req, res) => res.set('Cache-Control', 'no-store').json({ url: checkinUrl(req) }));

const qrCache = new Map();
app.get('/qr.svg', async (req, res, next) => {
  try {
    const url = checkinUrl(req);
    let svg = qrCache.get(url);
    if (!svg) {
      svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      if (qrCache.size > 20) qrCache.clear();
      qrCache.set(url, svg);
    }
    res.set('Cache-Control', 'no-cache').type('image/svg+xml').send(svg);
  } catch (e) { next(e); }
});

// auth
app.post('/api/login', (req, res) => {
  const now = Date.now();
  const f = loginFailures.get(req.ip);
  if (f && f.reset > now && f.count >= 10) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
  }
  const pw = req.body && req.body.password;
  const ok = typeof pw === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(pw).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  if (!ok) {
    if (!f || f.reset <= now) loginFailures.set(req.ip, { count: 1, reset: now + 60_000 });
    else f.count++;
    return res.status(401).json({ error: 'Wrong password' });
  }
  loginFailures.delete(req.ip);
  const exp = now + SESSION_MS;
  res.set('Set-Cookie', cookie(req, `${exp}.${sign(exp)}`, SESSION_MS / 1000)).json({ ok: true });
});
app.post('/api/logout', (req, res) => res.set('Set-Cookie', cookie(req, '', 0)).json({ ok: true }));
app.get('/api/me', (req, res) => res.set('Cache-Control', 'no-store').json({ admin: isAdmin(req) }));

// admin API
app.get('/api/events', requireAdmin, sse(clients.admin, 'state', getState));
app.get('/api/display/events', requireAdmin, sse(clients.display, 'display', getDisplay));
app.use(['/api/state', '/api/patients', '/api/next', '/api/export.csv', '/api/reset', '/api/settings'], requireAdmin);

app.get('/api/state', (req, res) => res.set('Cache-Control', 'no-store').json(getState()));

app.post('/api/patients', (req, res) => {
  const v = validate(req.body || {}, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const p = createPatient(v.data, null);
  scheduleBroadcast();
  res.status(201).json(p);
});

app.patch('/api/patients/:id', (req, res) => {
  const p = findPatient(req, res);
  if (!p) return;
  const body = req.body || {};
  const v = validate(body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  if (body.status !== undefined) {
    if (!['waiting', 'serving', 'done'].includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    v.data.status = body.status;
  }
  const updated = updatePatient(p, v.data);
  scheduleBroadcast();
  res.json(updated);
});

app.post('/api/patients/:id/move', (req, res) => {
  const p = findPatient(req, res);
  if (!p) return;
  const to = req.body && req.body.to;
  if (!['up', 'down', 'top', 'bottom'].includes(to)) return res.status(400).json({ error: 'to must be up, down, top or bottom' });
  if (p.status !== 'waiting') return res.status(400).json({ error: 'Only waiting patients can be moved' });
  const moved = movePatient(p, to);
  scheduleBroadcast();
  res.json(moved);
});

app.delete('/api/patients/:id', (req, res) => {
  const p = findPatient(req, res);
  if (!p) return;
  q.del.run(p.id);
  scheduleBroadcast();
  res.json({ ok: true });
});

app.post('/api/next', (req, res) => {
  const body = req.body || {};
  const count = body.count === undefined || body.count === null ? 1 : toInt(body.count);
  if (count === null || count < 1 || count > 50) return res.status(400).json({ error: 'count must be between 1 and 50' });
  const called = callNext(count, body.finishServing === true);
  scheduleBroadcast();
  res.json({ called });
});

const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = "'" + s; // spreadsheet formula injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
app.get('/api/export.csv', (req, res) => {
  const rows = [['number', 'name', 'age', 'country', 'reason', 'status', 'created', 'called', 'done']];
  for (const p of q.all.all()) {
    rows.push([p.number, p.name, p.age, p.country, p.reason, p.status, iso(p.created_at), iso(p.called_at), iso(p.done_at)]);
  }
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="queue-${day}.csv"` });
  res.send('\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
});

app.put('/api/settings', (req, res) => {
  const n = toInt((req.body || {}).maxServing);
  if (n === null || n < 1 || n > MAX_SERVING_LIMIT) return res.status(400).json({ error: `maxServing must be between 1 and ${MAX_SERVING_LIMIT}` });
  q.setMax.run(n);
  scheduleBroadcast();
  res.json({ maxServing: n });
});

app.post('/api/reset', (req, res) => {
  if (!req.body || req.body.confirm !== 'RESET') return res.status(400).json({ error: 'Send {"confirm":"RESET"} to reset' });
  resetAll();
  scheduleBroadcast();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// pages + static files
const noCacheHtml = (res, file) => res.set('Cache-Control', /\.html$/.test(file) ? 'no-cache' : 'public, max-age=600');
for (const page of ['admin', 'display', 'poster']) {
  app.get('/' + page, (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, page + '.html'), (err) => err && !res.headersSent && next());
  });
}
app.use(express.static(PUBLIC_DIR, { setHeaders: noCacheHtml }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal error' });
});

// ---------- start / stop ----------
const server = app.listen(PORT, () => {
  console.log(`Queue running at http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`  on your network: http://${n.address}:${PORT}`);
  }
  console.log(`  data: ${path.join(DATA_DIR, 'queue.db')}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('\n' + '!'.repeat(64) + '\n!!  WARNING: ADMIN_PASSWORD is not set — using the default "admin".\n' +
      '!!  Anyone can control the queue. Set ADMIN_PASSWORD before the event!\n' + '!'.repeat(64) + '\n');
  }
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  clearTimeout(broadcastTimer);
  for (const set of Object.values(clients)) for (const r of set) r.end();
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); db.close(); process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
