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
const _registerBuckets = new Map();  // ip → { tokens, refilledAt } — account creation
const AUTH_CAPACITY   = 5;   const AUTH_REFILL_PS  = 1;   // 5/burst, 1/s sustained
const ERROR_CAPACITY  = 30;  const ERROR_REFILL_PS = 5;
// Account creation is far rarer than login — a single human makes one account.
// Cap it hard per IP (5 burst, then 1 every 10 min) so a script can't mint
// thousands of accounts to flood the roster / DB during open beta. In-memory,
// so it resets on restart — that's fine layered on top of the auth bucket.
const REGISTER_CAPACITY = 5;  const REGISTER_REFILL_PS = 1 / 600;

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
export function _testValidateSaveData(data) { return _validateSaveData(data); }

// v1.7.740 — test hooks for the inventory mirror Phase 0. Exposes the sync
// + a read so wire-sim can assert table contents without coupling to the
// schema. Both wrap prepared statements created later in this file; the
// late-binding works because the test caller imports api.js (which runs
// the schema + prepare block top-to-bottom) before invoking either.
//
// v1.7.745 — `_testMirrorSync` is the SEED helper; it always bypasses the
// authoritative-server gate (via `{bootSeed:true}`) so test setup writes
// the mirror unconditionally regardless of the flag. To test the gated
// runtime path (`/api/save` calling `mirrorSyncFromSave`), use
// `_testMirrorSyncRuntime` instead — that one honors the flag.
export function _testMirrorSync(userId, slot, data) {
  return mirrorSyncFromSave(userId, slot, data, { bootSeed: true });
}
export function _testMirrorSyncRuntime(userId, slot, data) {
  return mirrorSyncFromSave(userId, slot, data);
}
// v1.7.744 — runtime override for the authoritative-server flag. Used by
// wire-sim to toggle the gate per-test without restarting the process.
// Returns the previous value so tests can restore it on teardown.
export function _testSetMirrorAuthoritative(on) {
  const prev = INV_MIRROR_AUTHORITATIVE_SERVER;
  INV_MIRROR_AUTHORITATIVE_SERVER = !!on;
  return prev;
}
export function _testGetMirrorAuthoritative() {
  return INV_MIRROR_AUTHORITATIVE_SERVER;
}
export function _testMirrorRead(userId, slot) {
  const econ = db.prepare('SELECT gil, cp, exp, unlocked_jobs FROM inv_economies WHERE user_id = ? AND slot = ?').get(userId, slot);
  const eq   = db.prepare('SELECT weapon_r, weapon_l, head, body, arms FROM inv_equipped WHERE user_id = ? AND slot = ?').get(userId, slot);
  const inv  = db.prepare('SELECT item_id, qty FROM inv_inventories WHERE user_id = ? AND slot = ? ORDER BY item_id').all(userId, slot);
  const sp   = db.prepare('SELECT spell_id FROM inv_known_spells WHERE user_id = ? AND slot = ? ORDER BY spell_id').all(userId, slot);
  const jl   = db.prepare('SELECT job_id, level, jp FROM inv_job_levels WHERE user_id = ? AND slot = ? ORDER BY job_id').all(userId, slot);
  return { econ, eq, inv, sp, jl };
}
export function _testMirrorClear(userId, slot) {
  db.prepare('DELETE FROM inv_inventories WHERE user_id = ? AND slot = ?').run(userId, slot);
  db.prepare('DELETE FROM inv_economies   WHERE user_id = ? AND slot = ?').run(userId, slot);
  db.prepare('DELETE FROM inv_equipped    WHERE user_id = ? AND slot = ?').run(userId, slot);
  db.prepare('DELETE FROM inv_known_spells WHERE user_id = ? AND slot = ?').run(userId, slot);
  db.prepare('DELETE FROM inv_job_levels  WHERE user_id = ? AND slot = ?').run(userId, slot);
}
function _validateSaveData(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'data must be an object' };
  const raw = JSON.stringify(data);
  if (raw.length > MAX_SAVE_SIZE_BYTES) return { ok: false, error: 'save too large' };

  // Whitelist + clamp every known field. Unknown keys get dropped (no surface
  // for future client bugs to inject arbitrary state into the DB).
  const out = {};
  if (Array.isArray(data.name))             out.name = data.name.slice(0, 8).map(b => _clamp(b, 0, 255));
  if (typeof data.level === 'number')        out.level = _clamp(data.level, 1, 5);   // level cap — mirror MAX_LEVEL in src/player-stats.js
  if (typeof data.exp === 'number')          out.exp = _clamp(data.exp, 0, 9999999);
  if (typeof data.hp === 'number')           out.hp = _clamp(data.hp, 0, 9999);
  if (typeof data.mp === 'number' || data.mp === null) out.mp = data.mp == null ? null : _clamp(data.mp, 0, 9999);
  if (data.stats && typeof data.stats === 'object') {
    // v1.7.450 — extended to include maxMP + equipment slot item-ids.
    // Pre-fix these were dropped by the server whitelist; on reload (server
    // preferred over IndexedDB) the player's equipment looked erased because
    // `slot.stats.weaponR/head/body/arms` came back undefined and the load
    // path fell back to new-game defaults. Equipment IDs are 0-255; 0 = empty.
    out.stats = {
      level:   _clamp(data.stats.level, 1, 5),   // level cap — mirror MAX_LEVEL in src/player-stats.js
      exp:     _clamp(data.stats.exp, 0, 9999999),
      hp:      _clamp(data.stats.hp, 0, 9999),
      maxHP:   _clamp(data.stats.maxHP, 1, 9999),
      maxMP:   _clamp(data.stats.maxMP, 0, 9999),
      str:     _clamp(data.stats.str, 1, 99),
      agi:     _clamp(data.stats.agi, 1, 99),
      vit:     _clamp(data.stats.vit, 1, 99),
      int:     _clamp(data.stats.int, 1, 99),
      mnd:     _clamp(data.stats.mnd, 1, 99),
      weaponR: _clamp(data.stats.weaponR, 0, 255),
      weaponL: _clamp(data.stats.weaponL, 0, 255),
      head:    _clamp(data.stats.head, 0, 255),
      body:    _clamp(data.stats.body, 0, 255),
      arms:    _clamp(data.stats.arms, 0, 255),
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
  // v1.7.600 — inventory slot order. Whitelist + clamp to bag-cap. Stale or
  // duplicate ids are filtered out by setPlayerInventory on load.
  // Cap MUST match `INV_CAP` in src/inventory.js — bumped to 16 in v1.7.689.
  if (Array.isArray(data.inventoryOrder)) {
    const order = [];
    const seen = new Set();
    for (const raw of data.inventoryOrder) {
      if (order.length >= 16) break;
      const id = parseInt(raw, 10);
      if (!Number.isFinite(id) || id < 0 || id > 255) continue;
      if (seen.has(id)) continue;
      order.push(id); seen.add(id);
    }
    out.inventoryOrder = order;
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
  if (typeof data.palIdx === 'number')       out.palIdx = _clamp(data.palIdx, 0, 7);
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
  if (data.consumedTilesAt && typeof data.consumedTilesAt === 'object' && !Array.isArray(data.consumedTilesAt)) {
    // Sibling of consumedTiles — per-tile open timestamps for 24h chest +
    // secret-treasure respawn. Was missing from this whitelist (v1.7.617)
    // so server round-trips dropped the cooldowns and Ur chests / secret
    // treasures came back instantly on next ROM load. Same shape as
    // consumedTiles (mapId → {key → epoch-ms}).
    out.consumedTilesAt = data.consumedTilesAt;
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
  CREATE TABLE IF NOT EXISTS parties (
    member_user_id INTEGER PRIMARY KEY,
    inviter_user_id INTEGER NOT NULL,
    joined_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (member_user_id) REFERENCES users(id),
    FOREIGN KEY (inviter_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS presence_shadows (
    user_id INTEGER PRIMARY KEY,
    name TEXT,
    loc TEXT,
    profile_json TEXT,
    last_seen INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_presence_shadows_last_seen ON presence_shadows(last_seen);
  CREATE TABLE IF NOT EXISTS bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    player_name TEXT,
    text TEXT NOT NULL,
    version TEXT,
    map_id INTEGER,
    tile_x INTEGER,
    tile_y INTEGER,
    on_world_map INTEGER,
    dungeon_floor INTEGER,
    battle_state TEXT,
    ip TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    sender_user_id  INTEGER NOT NULL,
    sender_name     TEXT,
    target_user_id  INTEGER NOT NULL,
    target_name     TEXT,
    item_id         INTEGER NOT NULL,
    accepted        INTEGER NOT NULL,
    reason          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
  CREATE INDEX IF NOT EXISTS idx_trades_sender ON trades(sender_user_id);
  -- Storage-persist beacon (v1.7.631). Unauthed, one row per first-tap. Used
  -- to measure GRANTED/DENIED ratio for navigator.storage.persist() across
  -- the open-beta population — specifically to rule in/out mobile Firefox
  -- storage eviction as a cause of the post-flip signup-without-save
  -- drop-off (4 of 5 new signups on launch day created an account but
  -- never wrote a save). No PII; UA is truncated to 120 chars.
  CREATE TABLE IF NOT EXISTS storage_beacons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,   -- Unix epoch SECONDS (v1.7.728+). Pre-v1.7.728 rows
                                    -- were stored as Date.now() ms; the boot migration
                                    -- below normalizes them in-place.
    already     INTEGER NOT NULL,   -- 1 = persisted() already true (returning visitor)
    granted     INTEGER NOT NULL,   -- 1 = persist() returned true
    ua          TEXT,
    ip          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_storage_beacons_ts ON storage_beacons(ts);

  -- Inventory mirror Phase 0 (v1.7.740). Server-canonical state mirror.
  -- READ-ONLY in Phase 0 — populated on every /api/save + at boot from
  -- existing saves, but not enforced. Future phases route mutations
  -- through wire events that validate against this state. Full design
  -- in docs/INVENTORY-MIRROR-PLAN.md.
  --
  -- All tables key on (user_id, slot) — each save slot is an independent
  -- character. Phase 1+ wire events will operate on the "active slot"
  -- which the WS hello fanout will start tracking.
  CREATE TABLE IF NOT EXISTS inv_inventories (
    user_id    INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    item_id    INTEGER NOT NULL,
    qty        INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_inv_inventories_updated ON inv_inventories(updated_at);

  CREATE TABLE IF NOT EXISTS inv_economies (
    user_id        INTEGER NOT NULL,
    slot           INTEGER NOT NULL,
    gil            INTEGER NOT NULL DEFAULT 0,
    cp             INTEGER NOT NULL DEFAULT 0,
    exp            INTEGER NOT NULL DEFAULT 0,
    unlocked_jobs  INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS inv_equipped (
    user_id    INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    weapon_r   INTEGER NOT NULL DEFAULT 0,
    weapon_l   INTEGER NOT NULL DEFAULT 0,
    head       INTEGER NOT NULL DEFAULT 0,
    body       INTEGER NOT NULL DEFAULT 0,
    arms       INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS inv_known_spells (
    user_id    INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    spell_id   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot, spell_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS inv_job_levels (
    user_id    INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    job_id     INTEGER NOT NULL,
    level      INTEGER NOT NULL DEFAULT 1,
    jp         INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot, job_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// v1.7.736 — hook for `/api/logout-all` so it can kick stale WS connections
// in real time. Set by `server.js` at boot to ws-presence's
// `revokeWsBeforeIat`. Pre-fix the watermark bump only blocked NEW requests;
// existing WS sessions kept running until each made its next HTTP call.
let _onLogoutAllHook = null;
export function setLogoutAllHook(fn) {
  _onLogoutAllHook = typeof fn === 'function' ? fn : null;
}

// JWT rotation column on `users`. Tokens issued before this unix-second
// timestamp are rejected as if expired. Bumped by `/api/logout-all` so a
// user with a stolen token can invalidate every outstanding session
// without changing their password. Pre-beta P3.
//
// `ALTER TABLE ADD COLUMN` is idempotent here only via try/catch — the
// column might already exist on a re-run.
try {
  db.exec('ALTER TABLE users ADD COLUMN token_iat_min INTEGER DEFAULT 0');
} catch (_) { /* column exists — fine */ }

// v1.7.728 — storage_beacons.ts was inserted as Date.now() (ms) from v1.7.631
// → v1.7.727. Normalize all ms-style values to Unix seconds so the column
// matches `users.created_at` / `presence_shadows.last_seen` / `bug_reports.
// created_at`, and `datetime(ts,'unixepoch')` works. Idempotent: the
// `> 1700000000000` guard matches ms timestamps from 2023+ (so it catches
// every existing row) and never matches a valid seconds-style insert (which
// caps well under that bound for the next ~50,000 years).
db.prepare("UPDATE storage_beacons SET ts = ts / 1000 WHERE ts > 1700000000000").run();

// ── Inventory mirror Phase 0 (v1.7.740) ──────────────────────────────
// Read-only server-side mirror of game state — populated from every save,
// not enforced yet. Future phases will route mutations through wire events
// that validate against this state. See `docs/INVENTORY-MIRROR-PLAN.md`.

const _invInvDeleteStmt   = db.prepare('DELETE FROM inv_inventories WHERE user_id = ? AND slot = ?');
const _invInvInsertStmt   = db.prepare('INSERT INTO inv_inventories (user_id, slot, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)');
const _invEconUpsertStmt  = db.prepare('INSERT OR REPLACE INTO inv_economies (user_id, slot, gil, cp, exp, unlocked_jobs, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const _invEquipUpsertStmt = db.prepare('INSERT OR REPLACE INTO inv_equipped (user_id, slot, weapon_r, weapon_l, head, body, arms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const _invSpellsDeleteStmt = db.prepare('DELETE FROM inv_known_spells WHERE user_id = ? AND slot = ?');
const _invSpellsInsertStmt = db.prepare('INSERT INTO inv_known_spells (user_id, slot, spell_id, updated_at) VALUES (?, ?, ?, ?)');
const _invJobsDeleteStmt  = db.prepare('DELETE FROM inv_job_levels WHERE user_id = ? AND slot = ?');
const _invJobsInsertStmt  = db.prepare('INSERT INTO inv_job_levels (user_id, slot, job_id, level, jp, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const _invEconReadStmt    = db.prepare('SELECT gil FROM inv_economies WHERE user_id = ? AND slot = ?');

// Wrap the slot replace in a single transaction so a save sync either fully
// lands or fully no-ops. Replace-semantics (DELETE then INSERT for the array-
// shaped tables) so the mirror state is whatever the save claims — Phase 0
// trusts the save fully (same as the existing `saves` table), but tracks it.
// v1.7.744 Phase 4 (partial) — authoritative-server gate. When true, the
// wire (inv-event) becomes the sole writer for inventory/gil/equipped;
// `mirrorSyncFromSave` no longer overwrites these fields at save time.
// This eliminates the race documented in INVENTORY-MIRROR-PLAN.md:
//   client mutates locally → fires inv-event (WS) → saveSlotsToDB (HTTP)
//   server receives in either order; if save lands first, it stamps the
//   mirror to N-1 from the just-written save, then the wire 'remove'
//   decrements again to N-2 — mirror under-counts by 1.
// With the gate on, the save path no-ops the wire-managed fields, so the
// wire's apply is idempotent regardless of HTTP/WS arrival order.
//
// Non-wire-managed fields (cp/exp/unlockedJobs/knownSpells/jobLevels)
// still sync from /api/save — no wire events for them yet. Phase 4 (full)
// would migrate them too and flip /api/save to a server-snapshot read.
//
// Boot seed bypasses the gate so empty mirrors get populated from the
// `saves` table even when the flag is on.
//
// v1.7.745 — FLIPPED ON. Paired flip with `INV_MIRROR_AUTHORITATIVE` in
// `src/net.js`. To roll back: set both back to `false` and redeploy.
let INV_MIRROR_AUTHORITATIVE_SERVER = true;

function mirrorSyncFromSave(userId, slot, data, opts) {
  const now = Math.floor(Date.now() / 1000);
  const bootSeed = !!(opts && opts.bootSeed);
  const skipWire = INV_MIRROR_AUTHORITATIVE_SERVER && !bootSeed;
  const tx = db.transaction(() => {
    // Inventory — wipe and replace. Skipped when wire is authoritative
    // (the wire handler owns this table; see `mirrorApplyInvEvent`).
    if (!skipWire) {
      _invInvDeleteStmt.run(userId, slot);
      if (data.inventory && typeof data.inventory === 'object' && !Array.isArray(data.inventory)) {
        for (const [k, v] of Object.entries(data.inventory)) {
          const id = parseInt(k, 10);
          if (!Number.isFinite(id) || id < 0 || id > 255) continue;
          const qty = (Number(v) | 0);
          if (qty <= 0) continue;
          _invInvInsertStmt.run(userId, slot, id, qty, now);
        }
      }
    }
    // Economy. When wire-authoritative, preserve the wire-managed `gil`
    // but still let cp/exp/unlocked_jobs sync from the save — no wire
    // events carry those fields yet.
    if (skipWire) {
      const prior = _invEconReadStmt.get(userId, slot);
      _invEconUpsertStmt.run(
        userId, slot,
        prior ? (prior.gil | 0) : (data.gil | 0),    // preserve wire-managed gil
        (data.cp | 0),
        (data.exp | 0),
        (data.unlockedJobs >>> 0),
        now,
      );
    } else {
      _invEconUpsertStmt.run(
        userId, slot,
        (data.gil | 0),
        (data.cp | 0),
        (data.exp | 0),
        (data.unlockedJobs >>> 0),    // unsigned — unlockedJobs is a 32-bit mask
        now,
      );
    }
    // Equipped — from stats.weaponR/L/head/body/arms. Skipped when wire
    // is authoritative (the wire's `equip` kind owns this table).
    if (!skipWire) {
      const st = (data.stats && typeof data.stats === 'object') ? data.stats : {};
      _invEquipUpsertStmt.run(
        userId, slot,
        (st.weaponR | 0),
        (st.weaponL | 0),
        (st.head | 0),
        (st.body | 0),
        (st.arms | 0),
        now,
      );
    }
    // Known spells — wipe and replace.
    _invSpellsDeleteStmt.run(userId, slot);
    if (Array.isArray(data.knownSpells)) {
      const seen = new Set();
      for (const id of data.knownSpells) {
        const sid = id | 0;
        if (sid < 0 || sid > 255) continue;
        if (seen.has(sid)) continue;
        seen.add(sid);
        _invSpellsInsertStmt.run(userId, slot, sid, now);
      }
    }
    // Job levels — wipe and replace.
    _invJobsDeleteStmt.run(userId, slot);
    if (data.jobLevels && typeof data.jobLevels === 'object' && !Array.isArray(data.jobLevels)) {
      for (const [k, v] of Object.entries(data.jobLevels)) {
        const jid = parseInt(k, 10);
        if (!Number.isFinite(jid) || jid < 0 || jid > 31) continue;
        if (!v || typeof v !== 'object') continue;
        _invJobsInsertStmt.run(userId, slot, jid, (v.level | 0), (v.jp | 0), now);
      }
    }
  });
  tx();
}

// Phase 0 divergence signal — log a warning when a sync claims a gil jump
// larger than what's plausibly earned between saves. Tunable; tier-2-style
// detection but free since we're already inside the sync. Threshold chosen
// so legitimate gameplay (vendor sells, level-up rewards) never trips it;
// real abuse (write-99999-gil-via-API) flags clearly.
const _MIRROR_GIL_JUMP_WARN = 50000;
function mirrorCheckDivergence(userId, slot, newData) {
  try {
    const prior = _invEconReadStmt.get(userId, slot);
    if (!prior) return;
    const newGil = (newData.gil | 0);
    const delta = newGil - (prior.gil | 0);
    if (delta > _MIRROR_GIL_JUMP_WARN) {
      console.warn('[mirror divergence] user=' + userId + ' slot=' + slot +
        ' gil jumped ' + prior.gil + ' → ' + newGil + ' (+' + delta + ')');
    }
  } catch { /* read failure is non-fatal */ }
}

// ── Phase 1a inv-event handlers (v1.7.741) ────────────────────────────
// Per-kind mutators. All take (userId, slot, ...) and either apply to the
// mirror or return a structured result describing what would have changed
// (in shadow mode, the apply is allowed even if the player's claimed prior
// state doesn't match — divergence is logged). Phase 1b will gate the
// apply behind a state-match check + emit inv-state corrective push.

const _invInvReadOneStmt  = db.prepare('SELECT qty FROM inv_inventories WHERE user_id = ? AND slot = ? AND item_id = ?');
const _invInvUpsertStmt   = db.prepare(
  'INSERT INTO inv_inventories (user_id, slot, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)' +
  ' ON CONFLICT(user_id, slot, item_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at'
);
const _invInvDeleteOneStmt = db.prepare('DELETE FROM inv_inventories WHERE user_id = ? AND slot = ? AND item_id = ?');
const _invEquipReadStmt   = db.prepare('SELECT weapon_r, weapon_l, head, body, arms FROM inv_equipped WHERE user_id = ? AND slot = ?');

// Returns { ok, applied?, reason?, mirrorBefore, mirrorAfter } describing
// the outcome. Shadow mode (Phase 1a) always returns ok:true and applies;
// Phase 1b will gate apply behind state matching and return ok:false with
// the corrective state on mismatch.
function mirrorApplyInvEvent(userId, slot, ev) {
  const now = Math.floor(Date.now() / 1000);
  const kind = String(ev.kind || '');
  const itemId = ev.itemId | 0;
  const qty = ev.qty | 0;
  // Bounds: itemId 0-255 (0 is "empty" / valid for equip-unset), qty signed
  // for gil-delta else positive. Reject out-of-bounds frames entirely —
  // these can't come from a legitimate client.
  if (itemId < 0 || itemId > 255) {
    return { ok: false, reason: 'bad-itemId' };
  }
  switch (kind) {
    case 'add': {
      if (qty <= 0 || qty > 99) return { ok: false, reason: 'bad-qty' };
      const cur = _invInvReadOneStmt.get(userId, slot, itemId);
      const before = cur ? (cur.qty | 0) : 0;
      const after = Math.min(99, before + qty);
      _invInvUpsertStmt.run(userId, slot, itemId, after, now);
      return { ok: true, before, after, kind, itemId };
    }
    case 'remove': {
      if (qty <= 0 || qty > 99) return { ok: false, reason: 'bad-qty' };
      const cur = _invInvReadOneStmt.get(userId, slot, itemId);
      const before = cur ? (cur.qty | 0) : 0;
      // Shadow mode: log divergence + apply anyway (client is source of
      // truth). Authoritative mode (Phase 1b, v1.7.745): reject without
      // applying; caller pushes corrective inv-state to the client.
      if (before < qty) {
        console.warn('[mirror divergence] user=' + userId + ' slot=' + slot +
          ' inv-event remove kind=' + kind + ' item=0x' + itemId.toString(16) +
          ' qty=' + qty + ' but mirror has ' + before + ' (src=' + (ev.source || '?') + ')');
        if (INV_MIRROR_AUTHORITATIVE_SERVER) {
          return { ok: false, reason: 'divergent-remove', before, requested: qty, itemId };
        }
      }
      const after = Math.max(0, before - qty);
      if (after === 0) _invInvDeleteOneStmt.run(userId, slot, itemId);
      else _invInvUpsertStmt.run(userId, slot, itemId, after, now);
      return { ok: true, before, after, kind, itemId, diverged: before < qty };
    }
    case 'equip': {
      // qty here is repurposed as the slot index: 0=weaponR, 1=weaponL,
      // 2=head, 3=body, 4=arms. itemId=0 → unequip.
      const slotMap = ['weapon_r', 'weapon_l', 'head', 'body', 'arms'];
      const slotName = slotMap[qty];
      if (!slotName) return { ok: false, reason: 'bad-slot' };
      const eq = _invEquipReadStmt.get(userId, slot) || {};
      const before = (eq[slotName] | 0);
      // SQL injection-safe — slotName from whitelist only.
      db.prepare('INSERT OR REPLACE INTO inv_equipped (user_id, slot, weapon_r, weapon_l, head, body, arms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        userId, slot,
        slotName === 'weapon_r' ? itemId : (eq.weapon_r | 0),
        slotName === 'weapon_l' ? itemId : (eq.weapon_l | 0),
        slotName === 'head'     ? itemId : (eq.head | 0),
        slotName === 'body'     ? itemId : (eq.body | 0),
        slotName === 'arms'     ? itemId : (eq.arms | 0),
        now,
      );
      return { ok: true, before, after: itemId, kind, equipSlot: slotName };
    }
    case 'unequip':
      // Equivalent to equip with itemId=0 + qty=slotIdx; client should
      // just send 'equip' with itemId=0. Reject for now to keep the
      // dispatch table small.
      return { ok: false, reason: 'use-equip-with-itemId-0' };
    case 'gil-delta': {
      // qty is signed for gil. Bound to ±999999 per event to defend
      // against int overflow.
      if (qty < -999999 || qty > 999999) return { ok: false, reason: 'bad-qty' };
      const cur = _invEconReadStmt.get(userId, slot);
      const before = cur ? (cur.gil | 0) : 0;
      // Authoritative mode rejects gil deltas that would underflow the
      // mirror (player claiming to spend gil they don't have). Shadow
      // mode clamps to 0 and applies.
      if (qty < 0 && before + qty < 0) {
        console.warn('[mirror divergence] user=' + userId + ' slot=' + slot +
          ' gil-delta=' + qty + ' but mirror has ' + before + ' (src=' + (ev.source || '?') + ')');
        if (INV_MIRROR_AUTHORITATIVE_SERVER) {
          return { ok: false, reason: 'divergent-gil', before, requested: qty };
        }
      }
      const after = Math.max(0, Math.min(999999, before + qty));
      _invEconUpsertStmt.run(
        userId, slot, after,
        cur ? cur.cp : 0, cur ? cur.exp : 0, cur ? cur.unlocked_jobs : 0,
        now,
      );
      return { ok: true, before, after, kind };
    }
    default:
      return { ok: false, reason: 'bad-kind' };
  }
}

// Read the full mirror state for (userId, slot) as a wire-shaped object
// suitable for sending as the body of an `inv-state` frame. Used for
// corrective state push in Phase 1b + hello-time sync in Phase 1c.
function mirrorReadFullState(userId, slot) {
  const econ = _invEconReadStmt.get(userId, slot) || {};
  const eqRow = _invEquipReadStmt.get(userId, slot) || {};
  const invRows = db.prepare('SELECT item_id, qty FROM inv_inventories WHERE user_id = ? AND slot = ?').all(userId, slot);
  const spRows  = db.prepare('SELECT spell_id FROM inv_known_spells WHERE user_id = ? AND slot = ?').all(userId, slot);
  const jlRows  = db.prepare('SELECT job_id, level, jp FROM inv_job_levels WHERE user_id = ? AND slot = ?').all(userId, slot);
  // Also need cp/exp/unlocked_jobs — re-read with the full row.
  const econFull = db.prepare('SELECT gil, cp, exp, unlocked_jobs FROM inv_economies WHERE user_id = ? AND slot = ?').get(userId, slot) || {};
  const inventory = {};
  for (const r of invRows) inventory[r.item_id] = r.qty;
  const jobLevels = {};
  for (const r of jlRows) jobLevels[r.job_id] = { level: r.level, jp: r.jp };
  return {
    slot,
    inventory,
    gil:          econFull.gil          | 0,
    cp:           econFull.cp           | 0,
    exp:          econFull.exp          | 0,
    unlockedJobs: econFull.unlocked_jobs >>> 0,
    equipped: {
      weaponR: eqRow.weapon_r | 0,
      weaponL: eqRow.weapon_l | 0,
      head:    eqRow.head     | 0,
      body:    eqRow.body     | 0,
      arms:    eqRow.arms     | 0,
    },
    knownSpells: spRows.map(r => r.spell_id),
    jobLevels,
  };
}

// Exports — the wire handler in ws-presence.js calls these.
export { mirrorApplyInvEvent, mirrorReadFullState };

// Boot seed — populate mirror from every existing save. Idempotent
// (transaction inside mirrorSyncFromSave is replace-semantics). Runs once
// at module load. Negligible cost: O(saves), ~13 users × ≤3 slots today.
(function _mirrorBootSeed() {
  const rows = db.prepare('SELECT user_id, slot, data FROM saves').all();
  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      // bootSeed:true bypasses the wire-authoritative gate so empty
      // mirrors still get populated when the flag is on. v1.7.744.
      mirrorSyncFromSave(row.user_id, row.slot, data, { bootSeed: true });
      synced++;
    } catch (e) {
      failed++;
      console.warn('[mirror seed] failed user=' + row.user_id + ' slot=' + row.slot + ': ' + e.message);
    }
  }
  if (synced > 0 || failed > 0) {
    console.log('[mirror seed] synced ' + synced + ' (user, slot) entries' +
      (failed > 0 ? ', ' + failed + ' failed' : ''));
  }
})();

// Party persistence (v1.7.595). The `parties` table is the source of truth
// for "who is in a party with whom"; `_partyMemberships` in ws-presence.js
// is the in-memory mirror, seeded from `partyLoadAll()` at boot and kept in
// lockstep by the helpers below. Persistent across disconnects + restarts;
// only explicit leave/dismiss removes a row.
const _partyAddStmt           = db.prepare('INSERT OR REPLACE INTO parties (member_user_id, inviter_user_id) VALUES (?, ?)');
const _partyRemoveMemberStmt  = db.prepare('DELETE FROM parties WHERE member_user_id = ?');
const _partyRemoveByInviterStmt = db.prepare('DELETE FROM parties WHERE inviter_user_id = ?');
const _partyLoadAllStmt       = db.prepare('SELECT member_user_id AS memberUserId, inviter_user_id AS inviterUserId FROM parties');

export function partyAddMember(memberUserId, inviterUserId) {
  _partyAddStmt.run(memberUserId | 0, inviterUserId | 0);
}
export function partyRemoveMember(memberUserId) {
  _partyRemoveMemberStmt.run(memberUserId | 0);
}
export function partyRemoveByInviter(inviterUserId) {
  _partyRemoveByInviterStmt.run(inviterUserId | 0);
}
export function partyLoadAll() {
  return _partyLoadAllStmt.all();
}

// Trade audit log (v1.7.616). Every trade response — accepted, declined,
// or blocked at the offer gate — is recorded so we can detect / forensically
// investigate item-dup abuse without a full server-side inventory mirror.
// Server still doesn't validate ownership (the documented limitation), but
// every trade is now traceable to the originating account. Inspect via
// `tools/trade-audit.cjs`.
const _tradeLogStmt = db.prepare(
  'INSERT INTO trades (ts, sender_user_id, sender_name, target_user_id, target_name, item_id, accepted, reason)' +
  ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
export function tradeLog(senderUserId, senderName, targetUserId, targetName, itemId, accepted, reason) {
  _tradeLogStmt.run(
    Date.now(),
    senderUserId | 0,
    String(senderName || ''),
    targetUserId | 0,
    String(targetName || ''),
    itemId | 0,
    accepted ? 1 : 0,
    reason || null,
  );
}

// Presence persistence (v1.7.596). Periodic snapshots of the live `_connected`
// roster so a crash doesn't dump everyone's overworld state. Source of truth
// is SQLite; `_shadows` in ws-presence.js is the post-boot in-memory mirror.
// Reaped on TTL; deleted explicitly on clean disconnect.
const _presenceUpsertStmt = db.prepare(
  'INSERT OR REPLACE INTO presence_shadows (user_id, name, loc, profile_json, last_seen) VALUES (?, ?, ?, ?, ?)'
);
const _presenceDeleteStmt = db.prepare('DELETE FROM presence_shadows WHERE user_id = ?');
const _presenceLoadRecentStmt = db.prepare(
  'SELECT user_id AS userId, name, loc, profile_json AS profileJson, last_seen AS lastSeen FROM presence_shadows WHERE last_seen >= ?'
);
const _presenceReapStmt = db.prepare('DELETE FROM presence_shadows WHERE last_seen < ?');

// db.transaction wraps a batch in one journal sync — meaningfully faster
// than N individual INSERTs when 100+ players are online.
const _presenceFlushBatchTxn = db.transaction((rows) => {
  for (const r of rows) {
    _presenceUpsertStmt.run(r.userId | 0, r.name, r.loc, r.profileJson, r.lastSeen | 0);
  }
});

export function presenceFlushBatch(rows) {
  if (!rows || rows.length === 0) return;
  _presenceFlushBatchTxn(rows);
}
export function presenceDelete(userId) {
  _presenceDeleteStmt.run(userId | 0);
}
export function presenceLoadRecent(sinceSec) {
  return _presenceLoadRecentStmt.all(sinceSec | 0);
}
export function presenceReap(beforeSec) {
  return _presenceReapStmt.run(beforeSec | 0).changes;
}

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

// Verify a JWT against `users.token_iat_min` so /api/logout-all (or any
// future server-side revocation) actually takes effect. Same return shape
// as `jwt.verify` on success; null on any failure (bad signature, expired,
// missing user, iat predates the revocation watermark). Used by both the
// HTTP middleware and `ws-presence.js` upgrade handler.
const _tokenIatMinStmt = db.prepare('SELECT token_iat_min FROM users WHERE id = ?');

// Test-only — `tools/pvp-wire-sim.js` and `tools/pvp-load-sim.js` mint
// JWTs for fabricated userIds. Without a matching `users` row the
// revocation check rejects them. This helper inserts a stub row if needed
// so test tokens validate. Never call from production paths.
const _testEnsureUserStmt = db.prepare(
  'INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, ?)');
export function _testEnsureUser(userId) {
  _testEnsureUserStmt.run(userId, 'test-' + userId + '@local', _DUMMY_HASH);
}

export function verifyTokenWithRevocation(token) {
  if (!token) return null;
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return null; }
  // Pre-beta: tokens minted before the column landed have no iat in the
  // payload only if a caller signed without expiresIn. Our login/register/
  // refresh paths all set expiresIn → iat is present. Be defensive anyway.
  if (!decoded || !decoded.userId || typeof decoded.iat !== 'number') return null;
  const row = _tokenIatMinStmt.get(decoded.userId);
  if (!row) return null;                                  // user deleted
  const min = row.token_iat_min | 0;
  if (decoded.iat < min) return null;                     // revoked
  return decoded;
}

function authMiddleware(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifyTokenWithRevocation(token);
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

  // POST /api/storage-beacon — record the outcome of
  // navigator.storage.persist() so we can measure how often browsers grant
  // durable storage to ff3mmo. Unauthed (no token at first-tap), reuses the
  // client-error rate bucket (same flood-defense profile: one beacon per
  // session per IP under normal traffic). v1.7.631.
  if (path === '/api/storage-beacon' && req.method === 'POST') {
    if (!_bucketAllow(_errorBuckets, ip, ERROR_CAPACITY, ERROR_REFILL_PS)) {
      res.writeHead(429); res.end(); return true;
    }
    const body = await readBody(req);
    db.prepare(
      'INSERT INTO storage_beacons (ts, already, granted, ua, ip) VALUES (?, ?, ?, ?, ?)'
    ).run(
      Math.floor(Date.now() / 1000),  // Unix seconds, matches rest of DB. v1.7.728.
      body.already ? 1 : 0,
      body.granted ? 1 : 0,
      String(body.ua || '').slice(0, 120),
      ip
    );
    res.writeHead(204); res.end();
    return true;
  }

  // POST /api/client-error — log client-side errors to pm2 logs. Unauthed;
  // rate-limited so a malicious client can't flood pm2 storage.
  //
  // Stale-cache rescue (v1.7.719): when the incoming error is a [BOOT ...]
  // class — fired from the early `window.addEventListener('error')` reporter
  // that runs before any module evaluates — it almost always means the
  // browser is serving a cached `index.html` from an obsolete version (the
  // smoke test would have caught a true new-code boot error before deploy).
  // The version-bust gate in current `index.html` can't help because the
  // cached HTML's `BUILD` literal matches the cached `ff3_build` localStorage
  // value (both stale), so no reload fires. We respond with
  // `Clear-Site-Data: "cache"` to purge the browser's HTTP cache for this
  // origin — on the next page load the browser hits the server, gets fresh
  // HTML with the new `BUILD`, the version-bust gate sees the mismatch
  // (cached localStorage vs fresh HTML BUILD), and the user is unstuck.
  // Scope = "cache" only, NOT "storage" — we never want to clear the
  // user's IndexedDB ROM cache or localStorage save slots. Mobile Firefox
  // (the browser that ignores `Cache-Control: no-store`) does honor
  // `Clear-Site-Data` on POST responses.
  if (path === '/api/client-error' && req.method === 'POST') {
    if (!_bucketAllow(_errorBuckets, ip, ERROR_CAPACITY, ERROR_REFILL_PS)) {
      res.writeHead(429); res.end(); return true;
    }
    const body = await readBody(req);
    const ctxStr = body.ctx ? '\n  ctx: ' + JSON.stringify(body.ctx) : '';
    console.error('[CLIENT ERROR]', body.msg, ctxStr, body.stack ? '\n' + body.stack : '');
    const isBootError = typeof body.msg === 'string' && body.msg.indexOf('[BOOT') === 0;
    const headers = isBootError ? { 'Clear-Site-Data': '"cache"' } : undefined;
    res.writeHead(204, headers); res.end();
    return true;
  }

  // POST /api/register
  if (path === '/api/register' && req.method === 'POST') {
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many requests — slow down' }), true;
    }
    if (!_bucketAllow(_registerBuckets, ip, REGISTER_CAPACITY, REGISTER_REFILL_PS)) {
      return send(res, 429, { error: 'Too many accounts from this network — try later' }), true;
    }
    const { email, password } = await readBody(req);
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return send(res, 400, { error: 'Email and password required' }), true;
    }
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

  // POST /api/refresh — sliding-window refresh for an existing token.
  // Returns a fresh 30-day token if the supplied token is valid and was
  // issued recently enough that we trust the holder is the live user. Older
  // tokens are rejected — the user has to log in again. Pre-beta P3.
  if (path === '/api/refresh' && req.method === 'POST') {
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many requests — slow down' }), true;
    }
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    // Reject refreshes for stale-but-not-yet-expired tokens. With 30-day
    // expiry, a stolen token still works for the rest of its window — but
    // it can't be refreshed past 21 days of age, so the original window
    // is the worst-case access for the attacker (vs. infinite chain).
    const MAX_REFRESH_AGE_S = 21 * 24 * 3600;
    const ageS = Math.floor(Date.now() / 1000) - user.iat;
    if (ageS > MAX_REFRESH_AGE_S) return send(res, 401, { error: 'Token too old — re-login' }), true;
    const newToken = jwt.sign({ userId: user.userId, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    send(res, 200, { token: newToken, email: user.email });
    return true;
  }

  // POST /api/logout-all — invalidate every outstanding session for this
  // user by bumping `users.token_iat_min` to now. The next request from any
  // existing token (HTTP or WS) sees `iat < token_iat_min` and gets a 401.
  // Pre-beta P3.
  if (path === '/api/logout-all' && req.method === 'POST') {
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many requests — slow down' }), true;
    }
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE users SET token_iat_min = ? WHERE id = ?').run(now, user.userId);
    // v1.7.736 — kick any live WS session for this user whose token iat
    // pre-dates the new watermark. Client's net.js retry loop will
    // reconnect with the fresh token returned below.
    if (_onLogoutAllHook) {
      try { _onLogoutAllHook(user.userId, now); }
      catch (e) { console.warn('[logout-all] WS revoke hook failed:', e); }
    }
    // Issue a fresh token so the caller (who just logged everyone else out)
    // stays signed in. iat = now ≥ token_iat_min so this one survives.
    const newToken = jwt.sign({ userId: user.userId, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    send(res, 200, { token: newToken, email: user.email });
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

  // POST /api/bug-report — file a gameplay bug report. Authed + rate-limited
  // under the auth bucket so spam is bounded. Stores free text plus the
  // client-supplied context (version, map/coords, battle state) for repro.
  // Logs to the `bug_reports` table for manual review — no automated action.
  if (path === '/api/bug-report' && req.method === 'POST') {
    const user = authMiddleware(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' }), true;
    if (!_bucketAllow(_authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_PS)) {
      return send(res, 429, { error: 'Too many reports — slow down' }), true;
    }
    const b = await readBody(req);
    const text = String(b.text || '').slice(0, 500);
    if (!text.trim()) return send(res, 400, { error: 'text required' }), true;
    const playerName = String(b.playerName || '').slice(0, 32) || null;
    const version    = String(b.version || '').slice(0, 32) || null;
    const battleState = String(b.battleState || '').slice(0, 32) || null;
    const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? _clamp(v | 0, lo, hi) : null;
    db.prepare(`INSERT INTO bug_reports
        (user_id, player_name, text, version, map_id, tile_x, tile_y, on_world_map, dungeon_floor, battle_state, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.userId, playerName, text, version,
           num(b.mapId, 0, 65535), num(b.tileX, 0, 4096), num(b.tileY, 0, 4096),
           b.onWorldMap ? 1 : 0, num(b.dungeonFloor, -1, 255), battleState, ip);
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
    // Phase 0 mirror sync (v1.7.740). Behavior-neutral: tracks the save's
    // claimed state in dedicated tables for future enforcement. Sync
    // failure logs but doesn't fail the save — the `saves` table is still
    // the source of truth in Phase 0.
    try {
      mirrorCheckDivergence(user.userId, slot, v.data);
      mirrorSyncFromSave(user.userId, slot, v.data);
    } catch (e) {
      console.warn('[mirror] sync failed user=' + user.userId + ' slot=' + slot + ': ' + e.message);
    }
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
    // Phase 0 mirror cleanup (v1.7.740) — wipe every mirror table for this
    // slot too, so a deleted save doesn't leave ghost rows. Same trust as
    // the save delete itself: client-authenticated, no extra validation.
    try {
      const tx = db.transaction(() => {
        _invInvDeleteStmt.run(user.userId, slot);
        db.prepare('DELETE FROM inv_economies  WHERE user_id = ? AND slot = ?').run(user.userId, slot);
        db.prepare('DELETE FROM inv_equipped   WHERE user_id = ? AND slot = ?').run(user.userId, slot);
        _invSpellsDeleteStmt.run(user.userId, slot);
        _invJobsDeleteStmt.run(user.userId, slot);
      });
      tx();
    } catch (e) {
      console.warn('[mirror] delete failed user=' + user.userId + ' slot=' + slot + ': ' + e.message);
    }
    send(res, 200, { ok: true });
    return true;
  }

  return false; // not an API route
}
