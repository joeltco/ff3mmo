// Auth + Save API — handles /api/* routes
import { createRequire } from 'module';
import { createHmac } from 'crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';
const SALT_ROUNDS = 10;

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

  // POST /api/client-error — log client-side errors to pm2 logs
  if (path === '/api/client-error' && req.method === 'POST') {
    const body = await readBody(req);
    console.error('[CLIENT ERROR]', body.msg, '\n', body.stack || '');
    res.writeHead(204); res.end();
    return true;
  }

  // POST /api/register
  if (path === '/api/register' && req.method === 'POST') {
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
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: 'Email and password required' }), true;
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return send(res, 401, { error: 'Invalid email or password' }), true;
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return send(res, 401, { error: 'Invalid email or password' }), true;
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    send(res, 200, { token, email: user.email });
    return true;
  }

  // POST /api/save
  if (path === '/api/save' && req.method === 'POST') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    const { slot, data } = await readBody(req);
    if (slot === undefined || !data) return send(res, 400, { error: 'slot and data required' }), true;
    if (![0, 1, 2].includes(slot)) return send(res, 400, { error: 'slot must be 0, 1, or 2' }), true;
    db.prepare('INSERT OR REPLACE INTO saves (user_id, slot, data, updated_at) VALUES (?, ?, ?, unixepoch())').run(user.userId, slot, JSON.stringify(data));
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
