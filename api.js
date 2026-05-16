// Auth + Save API — handles /api/* routes
import { createRequire } from 'module';
import { createHmac } from 'crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';
const SALT_ROUNDS = 10;

// Per-IP rate-limit buckets. Auth endpoints (login + register) are bcrypt-
// gated and would let an attacker pin a CPU on bursty requests. The
// client-error endpoint has no auth and can flood pm2 logs. Same token-
// bucket shape as `ws-presence.js#_rateAllow`.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md — pre-beta P0 #3.
const _authBuckets    = new Map();   // ip → { tokens, refilledAt }
const _errorBuckets   = new Map();
const AUTH_CAPACITY   = 5;   const AUTH_REFILL_PS  = 1;   // 5/burst, 1/s sustained
const ERROR_CAPACITY  = 30;  const ERROR_REFILL_PS = 5;

function _bucketAllow(map, ip, capacity, refillPs) {
  const now = Date.now();
  let b = map.get(ip);
  if (!b) { b = { tokens: capacity, refilledAt: now }; map.set(ip, b); }
  const elapsed = (now - b.refilledAt) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPs);
    b.refilledAt = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function _getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Generate a dummy bcrypt hash at module load. Login uses it for a sham
// `bcrypt.compare` when the email isn't registered — keeps response latency
// for "user not found" indistinguishable from "wrong password", which
// otherwise leaks account enumeration via timing. ~100 ms once at boot.
const _DUMMY_HASH = bcrypt.hashSync('ff3mmo-timing-equalizer-' + Math.random(), SALT_ROUNDS);

// Validate + sanitize a save slot before storing. Reject obvious garbage
// (wrong types, oversize payload, fields wildly out of range); clamp
// recoverable values rather than throw, so a slightly-buggy client doesn't
// brick its slot on every save. Returns `{ ok: true, data }` on accept (with
// the cleaned payload) or `{ ok: false, error }` on reject.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md — pre-beta P1 #2.
const MAX_SAVE_SIZE_BYTES = 16 * 1024;
function _clamp(n, min, max) {
  const v = (n | 0) || 0;
  return v < min ? min : (v > max ? max : v);
}
function _validateSaveData(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'data must be an object' };
  const raw = JSON.stringify(data);
  if (raw.length > MAX_SAVE_SIZE_BYTES) return { ok: false, error: 'save too large' };

  // Whitelist + clamp every known field. Unknown keys get dropped (no surface
  // for future client bugs to inject arbitrary state into the DB).
  const out = {};
  if (Array.isArray(data.name))             out.name = data.name.slice(0, 8).map(b => _clamp(b, 0, 255));
  if (typeof data.level === 'number')        out.level = _clamp(data.level, 1, 99);
  if (typeof data.exp === 'number')          out.exp = _clamp(data.exp, 0, 9999999);
  if (typeof data.hp === 'number')           out.hp = _clamp(data.hp, 0, 9999);
  if (typeof data.mp === 'number' || data.mp === null) out.mp = data.mp == null ? null : _clamp(data.mp, 0, 9999);
  if (data.stats && typeof data.stats === 'object') {
    out.stats = {
      level:  _clamp(data.stats.level, 1, 99),
      exp:    _clamp(data.stats.exp, 0, 9999999),
      hp:     _clamp(data.stats.hp, 0, 9999),
      maxHP:  _clamp(data.stats.maxHP, 1, 9999),
      str:    _clamp(data.stats.str, 1, 99),
      agi:    _clamp(data.stats.agi, 1, 99),
      vit:    _clamp(data.stats.vit, 1, 99),
      int:    _clamp(data.stats.int, 1, 99),
      mnd:    _clamp(data.stats.mnd, 1, 99),
    };
  }
  if (data.inventory && typeof data.inventory === 'object' && !Array.isArray(data.inventory)) {
    const inv = {};
    let n = 0;
    for (const k of Object.keys(data.inventory)) {
      if (n++ >= 64) break;                            // cap inventory key count
      const id = parseInt(k, 10);
      if (!Number.isFinite(id) || id < 0 || id > 255) continue;
      inv[id] = _clamp(data.inventory[k], 0, 99);      // qty 0-99 per slot
    }
    out.inventory = inv;
  }
  if (typeof data.gil === 'number')          out.gil = _clamp(data.gil, 0, 999999);
  if (data.jobLevels && typeof data.jobLevels === 'object') {
    const jl = {};
    let n = 0;
    for (const k of Object.keys(data.jobLevels)) {
      if (n++ >= 32) break;
      const job = data.jobLevels[k];
      if (!job || typeof job !== 'object') continue;
      jl[k] = {
        level: _clamp(job.level, 1, 99),
        jp:    _clamp(job.jp, 0, 9999),
      };
    }
    out.jobLevels = jl;
  }
  if (typeof data.jobIdx === 'number')       out.jobIdx = _clamp(data.jobIdx, 0, 31);
  if (typeof data.unlockedJobs === 'number') out.unlockedJobs = _clamp(data.unlockedJobs, 0, 0xFFFFFFFF);
  if (typeof data.cp === 'number')           out.cp = _clamp(data.cp, 0, 999999);
  if (typeof data.statusMask === 'number')   out.statusMask = _clamp(data.statusMask, 0, 0xFFFF);
  if (typeof data.statusPoisonTick === 'number') out.statusPoisonTick = _clamp(data.statusPoisonTick, 0, 99);
  if (typeof data.worldX === 'number' || data.worldX === null) out.worldX = data.worldX == null ? null : _clamp(data.worldX, 0, 4096);
  if (typeof data.worldY === 'number' || data.worldY === null) out.worldY = data.worldY == null ? null : _clamp(data.worldY, 0, 4096);
  if (typeof data.onWorldMap === 'boolean' || data.onWorldMap === null) out.onWorldMap = data.onWorldMap;
  if (typeof data.currentMapId === 'number' || data.currentMapId === null) out.currentMapId = data.currentMapId == null ? null : _clamp(data.currentMapId, 0, 65535);
  if (typeof data.lastTown === 'number')     out.lastTown = _clamp(data.lastTown, 0, 65535);
  if (typeof data.lastWorldExitX === 'number' || data.lastWorldExitX === null) out.lastWorldExitX = data.lastWorldExitX == null ? null : _clamp(data.lastWorldExitX, 0, 4096);
  if (typeof data.lastWorldExitY === 'number' || data.lastWorldExitY === null) out.lastWorldExitY = data.lastWorldExitY == null ? null : _clamp(data.lastWorldExitY, 0, 4096);
  if (typeof data.playTime === 'number')     out.playTime = Math.max(0, Math.min(data.playTime, 999999));  // seconds
  if (Array.isArray(data.knownSpells))       out.knownSpells = data.knownSpells.slice(0, 64).map(s => _clamp(s, 0, 255));
  if (data.consumedTiles && typeof data.consumedTiles === 'object' && !Array.isArray(data.consumedTiles)) {
    // Keep as-is; capped indirectly by overall payload size. Each key is a
    // map id, each value is a per-tile set of consumed coords.
    out.consumedTiles = data.consumedTiles;
  }
  return { ok: true, data: out };
}

// Init DB
const db = new Database('./ff3mmo.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER NOT NULL,
    slot INTEGER NOT NULL CHECK(slot IN (0,1,2)),
    data TEXT,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_user_id INTEGER NOT NULL,
    target_user_id INTEGER,
    target_name TEXT,
    reason TEXT,
    ip TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (reporter_user_id) REFERENCES users(id)
  );
`);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function authMiddleware(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

export async function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    res.end();
    return true;
  }

  const ip = _getIp(req);

  // POST /api/client-error — log client-side errors to pm2 logs. Unauthed;
  // rate-limited so a malicious client can't flood pm2 storage.
  if (path === '/api/client-error' && req.method === 'POST') {
    if (!_bucketAllow(_errorBuckets, ip, ERROR_CAPACITY, ERROR_REFILL_PS)) {
      res.writeHead(429); res.end(); return true;
    }
    const body = await readBody(req);
    const ctxStr = body.ctx ? '\n  ctx: ' + JSON.stringify(body.ctx) : '';
    console.error('[CLIENT ERROR]', body.msg, ctxStr, body.stack ? '\n' + body.stack : '');
    res.writeHead(204); res.end();
    return true;
  }

  // POST /api/register
  if (path === '/api/register' && req.method === 'POST') {
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many requests — slow down' }), true;
    }
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: 'Email and password required' }), true;
    if (password.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' }), true;
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return send(res, 409, { error: 'Email already registered' }), true;
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase(), hash);
    const token = jwt.sign({ userId: result.lastInsertRowid, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    send(res, 201, { token, email: email.toLowerCase() });
    return true;
  }

  // POST /api/login
  if (path === '/api/login' && req.method === 'POST') {
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many requests — slow down' }), true;
    }
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: 'Email and password required' }), true;
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email.toLowerCase());
    // Always run a bcrypt.compare — sham one against _DUMMY_HASH when the
    // email doesn't exist — so response timing doesn't leak which emails
    // are registered. Single 401 message either way.
    const hashToCheck = user ? user.password_hash : _DUMMY_HASH;
    const match = await bcrypt.compare(password, hashToCheck);
    if (!user || !match) return send(res, 401, { error: 'Invalid email or password' }), true;
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    send(res, 200, { token, email: user.email });
    return true;
  }

  // POST /api/chat-report — file a player report. Rate-limited under the
  // same auth bucket so spam is bounded. Logs to the `reports` table for
  // moderator review; no automated action today. Audit-style trail only.
  // See docs/MULTIPLAYER-AUDIT-2026-05-15.md — pre-beta P1 #3.
  if (path === '/api/chat-report' && req.method === 'POST') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many reports — slow down' }), true;
    }
    const { targetUserId, targetName, reason } = await readBody(req);
    const cleanReason = String(reason || '').slice(0, 200);
    if (!cleanReason) return send(res, 400, { error: 'reason required' }), true;
    const cleanName = String(targetName || '').slice(0, 32) || null;
    const tgtId = targetUserId == null ? null : (targetUserId | 0) || null;
    db.prepare('INSERT INTO reports (reporter_user_id, target_user_id, target_name, reason, ip) VALUES (?, ?, ?, ?, ?)')
      .run(user.userId, tgtId, cleanName, cleanReason, ip);
    send(res, 200, { ok: true });
    return true;
  }

  // POST /api/save
  if (path === '/api/save' && req.method === 'POST') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    const { slot, data } = await readBody(req);
    if (slot === undefined || !data) return send(res, 400, { error: 'slot and data required' }), true;
    if (![0, 1, 2].includes(slot)) return send(res, 400, { error: 'slot must be 0, 1, or 2' }), true;
    // Validate + clamp. Rejected payloads return 400 with a reason so the
    // client can surface it instead of silently succeeding with garbage.
    const v = _validateSaveData(data);
    if (!v.ok) return send(res, 400, { error: v.error }), true;
    db.prepare('INSERT OR REPLACE INTO saves (user_id, slot, data, updated_at) VALUES (?, ?, ?, unixepoch())').run(user.userId, slot, JSON.stringify(v.data));
    send(res, 200, { ok: true });
    return true;
  }

  // GET /api/saves
  if (path === '/api/saves' && req.method === 'GET') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    const rows = db.prepare('SELECT slot, data FROM saves WHERE user_id = ?').all(user.userId);
    const slots = [null, null, null];
    for (const row of rows) {
      try { slots[row.slot] = JSON.parse(row.data); }
      catch { slots[row.slot] = null; }
    }
    send(res, 200, { slots });
    return true;
  }

  // DELETE /api/save
  if (path === '/api/save' && req.method === 'DELETE') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    const { slot } = await readBody(req);
    if (![0, 1, 2].includes(slot)) return send(res, 400, { error: 'slot must be 0, 1, or 2' }), true;
    db.prepare('DELETE FROM saves WHERE user_id = ? AND slot = ?').run(user.userId, slot);
    send(res, 200, { ok: true });
    return true;
  }

  return false; // not an API route
}
