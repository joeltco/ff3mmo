// world-sfx-sweep.cjs — capture the NON-battle SFX by triggering them.
//
// `spell-sweep.cjs` captures every sound a SPELL makes, because it can cast all
// 56 of them. It cannot open a chest, walk through a door, flee a fight, or move
// a menu cursor, so v1.7.873 shipped with 11 constants still carrying a
// `SFX $NN + $41` formula instead of a measurement. This drives those events.
//
//   node tools/monscan/world-sfx-sweep.cjs            # every scenario
//   node tools/monscan/world-sfx-sweep.cjs selftest   # instrument check only
//   node tools/monscan/world-sfx-sweep.cjs menu intro # named scenarios
//
// ── How a sound is identified ──────────────────────────────────────────────
//
// FF3J fires a sound by writing `0x80 | sfxId` to $7F49 (battery RAM), and the
// NSF track we play is `sfxId + 0x41`, i.e. `written - 0x3F`. Watching the value
// alone is not enough — several events share a value, and the enemy-turn cadence
// `$b6` shows up in windows it does not belong to (the v1.7.870 trap). So every
// write is tagged with the CPU PC and resolved back to a ROM OFFSET, which makes
// the identification exact: the ROM contains exactly one `LDA #$BF / STA $7F49`,
// so a write from that offset IS the treasure sound, whatever else is on screen.
//
// 60 of the ROM's 67 stores to $7F49 are `LDA #imm` (a fixed sound at a fixed
// code site); the other 7 are fed from memory. The busiest of those is
// `LDA $CA / ORA #$80` (0x7fb0e), a general dispatcher that plays whatever id
// the caller left in $CA — most menu and spell sounds arrive through it. (The
// small `LDA $A047,X` table at $A033 is NOT that source: it is 32 bytes holding
// only 6 distinct ids. Checked, because assuming it was the spell table would
// have made the next paragraph's reasoning look stronger than it is.)
//
// So a value absent from the immediate set is NOT evidence the constant is
// wrong — SIGHT and FIRE_BOOM are both measured-correct and both absent, since
// they arrive via $CA. Only the code SITE proves what an event plays.
//
// ── Why the selftest exists ────────────────────────────────────────────────
//
// PC-tagging is an instrument, and an instrument that silently mis-resolves
// would produce confident wrong answers — exactly the failure this whole sweep
// arc keeps hitting (docs/SWEEP-DISCIPLINE.md). `selftest` drives the name grid,
// which is pure menu input, and asserts three things: the menu-confirm sound
// arrives as $85 (measured independently in v1.7.873, via the battle sweep's
// control round) from a site that literally holds `LDA #$85`; every write
// resolves; and every resolved offset is a real $7F49 store. If that fails,
// nothing else in this file is trustworthy.
//
// A screen is photographed the first time each sound is heard (`SHOOT=0` to
// skip). Reading a captured value back against our own constant would be
// circular — seeing a door on screen is what makes it the door sound.

const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM_PATH = REPO + '/FF3-English.nes';
const OUT = process.env.OUT || (__dirname + '/world-sfx-sweep.json');
const SHOOT = process.env.SHOOT !== '0';
// Values to photograph on EVERY occurrence, not just the first. A sound heard
// seven times in one run may be seven different events; one screenshot cannot
// tell you which. `WATCH=83,94` to chase a specific unattributed value.
const WATCH = new Set((process.env.WATCH || '').split(',').filter(Boolean)
  .map((v) => parseInt(v, 16)));
const SHOT_DIR = process.env.SHOT_DIR || (__dirname + '/world-sfx-shots');
const rom = readFileSync(ROM_PATH);
if (SHOOT) { try { require('fs').mkdirSync(SHOT_DIR, { recursive: true }); } catch { /* exists */ } }

const SFX_REG = 0x7F49;

// ── ROM site index ─────────────────────────────────────────────────────────
// Every store to $7F49, with the immediate value when the store is fed by a
// literal. Built once; used to turn a resolved ROM offset into a name.
function buildSiteIndex() {
  const sites = new Map();
  const STORE = { 0x8D: 'STA', 0x9D: 'STA,X', 0x99: 'STA,Y', 0x8E: 'STX', 0x8C: 'STY' };
  for (let i = 2; i + 2 < rom.length; i++) {
    if (rom[i + 1] !== 0x49 || rom[i + 2] !== 0x7F || !STORE[rom[i]]) continue;
    const imm = rom[i - 2] === 0xA9 ? rom[i - 1] : null;   // LDA #imm immediately before
    sites.set(i, { off: i, kind: STORE[rom[i]], imm });
  }
  return sites;
}
const SITES = buildSiteIndex();

// ── PC -> ROM offset ───────────────────────────────────────────────────────
// jsnes mirrors the currently-mapped PRG into cpu.mem, so the bytes around the
// PC at write time are the real instruction stream. Rather than decode MMC3's
// bank registers, take a window of that stream and find where it occurs in the
// ROM.
//
// MEASURED, not assumed: at hook time jsnes' REG_PC sits on the LAST byte of the
// store, so the opcode is at pc-2 and the operand at pc-1/pc. Verified by
// dumping raw windows — every one of 14 distinct writes showed `?? 49 7F` at
// exactly pc-2, including table-fed sites. Scanning the window for "some store
// near the PC" instead would silently pick a neighbouring store when two sit
// close together, so the offset is pinned rather than searched.
const PC_TO_STORE = 2;
const _sigCache = new Map();

function resolveSite(win, winBase, pc) {
  const staAt = (pc - PC_TO_STORE) - winBase;
  if (staAt < 0 || staAt + 3 > win.length) return { resolved: false, why: 'window too short' };
  if (win[staAt + 1] !== 0x49 || win[staAt + 2] !== 0x7F) {
    return { resolved: false, why: 'no $7F49 store at pc-2' };
  }
  // Signature: 12 bytes of the instruction stream ending at the store, plus the
  // store. 15 bytes of 6502 is effectively unique; when it is not, every
  // candidate is reported rather than one being picked.
  const sigLo = Math.max(0, staAt - 12);
  const sig = win.slice(sigLo, staAt + 3);
  const key = sig.join(',');
  if (_sigCache.has(key)) return _sigCache.get(key);

  const hits = [];
  for (let i = 0; i + sig.length <= rom.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) if (rom[i + j] !== sig[j]) { ok = false; break; }
    if (ok) hits.push(i + (staAt - sigLo));     // ROM offset OF THE STORE
  }
  const r = hits.length === 1
    ? { resolved: true, off: hits[0] }
    : { resolved: false, why: hits.length ? `${hits.length} candidates` : 'no ROM match', hits };
  _sigCache.set(key, r);
  return r;
}

// ── recorder ───────────────────────────────────────────────────────────────
function makeRecorder(scenario) {
  const rec = { phase: 'boot', log: [], nes: null, seen: new Set(), shot: null, shots: [], mapDelta: [], watchBattle: [] };
  rec.hook = (addr, value) => {
    if (addr !== SFX_REG) return;
    const n = rec.nes;
    if (!n) return;
    const pc = n.nes.cpu.REG_PC;
    const base = Math.max(0, pc - 24);
    const win = [];
    for (let a = base; a <= pc + 8; a++) win.push(n.nes.cpu.mem[a] & 0xFF);
    rec.log.push({ frame: n.frames, phase: rec.phase, value, pc, win, winBase: base });
    // First time this sound is heard, arrange to photograph the screen. Matching
    // a captured value against our own constant would be circular — the only way
    // to say "this is the door sound" is to see a door. The shot is taken at the
    // next frame boundary because the framebuffer is mid-render inside the hook.
    if (SHOOT && (!rec.seen.has(value) || WATCH.has(value))) {
      rec.seen.add(value);
      rec.shot = `${scenario}-f${n.frames}-${rec.phase}-$${value.toString(16)}`;
    }
    // Did a battle start right after this sound? The encounter swoosh should
    // always be followed by one; a sound that is merely COMMON on the field
    // should not be. Correlation over many firings is the test, not one look.
    rec.watchBattle.push({ value, frame: n.frames, until: n.frames + 240, sawBattle: false });
  };
  return rec;
}

// A single frame at the moment of the write is often not enough to say what
// happened — a map transition and a chest opening look identical on the frame
// the sound starts. So each sound is photographed twice: at the write, and
// SHOT_AFTER frames later, by which point a door has landed on a new map and a
// chest has not.
const SHOT_AFTER = parseInt(process.env.SHOT_AFTER || '70', 10);

/** Cheap hash of the visible nametable. */
function mapFingerprint(n) {
  const v = n.vram; let h = 0;
  for (let i = 0x2000; i < 0x23C0; i++) h = (h * 31 + v[i]) & 0x7FFFFFFF;
  return h;
}

// The nametable alone cannot answer "was that a map transition" — FF3 scrolls,
// so it changes on every step. A transition DOES black the screen out, and
// walking never does, so blackness within the follow-up window is the decisive
// test. Checked every frame rather than at the endpoint because the fade is
// brief and sampling once would miss it.
function screenIsBlack(n) {
  let lit = 0;
  for (let i = 0; i < n.fb.length; i += 7) {          // stride-sample; exactness not needed
    const px = n.fb[i];
    if (((px & 0xFF) + ((px >> 8) & 0xFF) + ((px >> 16) & 0xFF)) > 90) lit++;
  }
  return lit < (n.fb.length / 7) * 0.04;
}

/** Wrap `run` so pending screenshots land on completed frames. */
function armShots(n, rec) {
  const origRun = n.run.bind(n);
  rec.pending = [];
  n.run = (k) => {
    for (let i = 0; i < k; i++) {
      origRun(1);
      if (rec.shot) {
        const path = `${SHOT_DIR}/${rec.shot}.png`;
        n.screenshot(path);
        rec.shots.push(path);
        rec.pending.push({ at: n.frames + SHOT_AFTER, path: `${SHOT_DIR}/${rec.shot}+after.png`,
                           label: rec.shot, bg: mapFingerprint(n), black: false });
        rec.shot = null;
      }
      for (const w of rec.watchBattle) {
        if (!w.sawBattle && n.frames > w.frame && n.frames <= w.until && spriteCount(n) > 12) w.sawBattle = true;
      }
      for (let p = rec.pending.length - 1; p >= 0; p--) {
        if (!rec.pending[p].black && screenIsBlack(n)) rec.pending[p].black = true;
        if (rec.pending[p].at <= n.frames) {
          const q = rec.pending[p];
          n.screenshot(q.path);
          rec.shots.push(q.path);
          // Objective "did the map change" — a door transition repaints the
          // whole nametable, walking does not. Reading that off a screenshot by
          // eye is exactly the kind of judgement call that has been wrong before.
          rec.mapDelta.push({ label: q.label, changed: mapFingerprint(n) !== q.bg, faded: q.black });
          rec.pending.splice(p, 1);
        }
      }
    }
    return n;
  };
  return n;
}

/** Collapse a raw log into one row per (phase, value, site). */
function summarize(log) {
  const out = new Map();
  for (const e of log) {
    const r = resolveSite(e.win, e.winBase, e.pc);
    const off = r.resolved ? r.off : null;
    const key = `${e.phase}|${e.value}|${off === null ? 'x' : off}`;
    if (!out.has(key)) {
      const site = off !== null ? SITES.get(off) : null;
      out.set(key, {
        phase: e.phase, value: e.value, nsf: (e.value - 0x3F) & 0xFF,
        site: off, siteImm: site ? site.imm : null, siteKind: site ? site.kind : null,
        // A site whose literal disagrees with the value that arrived is NOT a
        // resolver error — $E28F is entered two ways, once falling through
        // `LDA #$94` (screen open) and once jumped straight to with A already
        // holding $93 (screen close). Flagged so the shared-store case is
        // visible instead of being read as a clean 1:1 site->sound mapping.
        sharedStore: site && site.imm !== null && site.imm !== e.value,
        why: r.resolved ? null : r.why, count: 0, firstFrame: e.frame, frames: [],
      });
    }
    const row = out.get(key);
    row.count++;
    if (row.frames.length < 12) row.frames.push(e.frame);
  }
  return [...out.values()].sort((a, b) => a.firstFrame - b.firstFrame);
}

function printRows(rows, title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
  if (!rows.length) { console.log('  (no $7F49 writes)'); return; }
  console.log('  phase           wrote  nsf   ROM site    imm    n   first frame');
  for (const r of rows) {
    const site = r.site === null ? `unresolved(${r.why})` : '0x' + r.site.toString(16);
    const imm = r.siteImm === null ? (r.site === null ? '' : 'table')
      : '$' + r.siteImm.toString(16) + (r.sharedStore ? '*' : '');
    console.log('  ' + r.phase.padEnd(16) + ('$' + r.value.toString(16)).padEnd(7)
      + String(r.nsf).padEnd(6) + site.padEnd(12) + imm.padEnd(7)
      + String(r.count).padStart(3) + '   ' + r.firstFrame);
  }
  if (rows.some((r) => r.sharedStore)) {
    console.log('  * shared store — the site is reached with A already loaded, so its');
    console.log('    fall-through literal is not the sound that played. Trust the value.');
  }
}

// ── boot ───────────────────────────────────────────────────────────────────
// Joel's intro sequence, same as reach-battle.cjs: six A presses then DOWN,
// repeated, walks the name grid through all four characters; the game then runs
// on into the Altar Cave on its own.
function boot(rec, { name = true } = {}) {
  const n = armShots(new Nes(ROM_PATH, { onBatteryRamWrite: rec.hook }), rec);
  rec.nes = n;
  rec.phase = 'title';
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  if (name) {
    rec.phase = 'naming';
    for (let block = 0; block < 10; block++) {
      for (let k = 0; k < 6; k++) n.press('a', 8, 25);
      n.press('down', 8, 40);
    }
  }
  return n;
}

/** Sprite count — >12 means a battle is on screen (same test status-offset uses). */
function spriteCount(n) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
}

/** Walk until a random encounter starts. Returns true if one did. */
function reachBattle(n, rec) {
  for (let blk = 0; blk < 200; blk++) {
    for (const dir of ['down', 'up', 'right', 'left']) {
      n.hold(dir, 16); n.run(4);
      if (spriteCount(n) > 12) return true;
    }
    // Nudge out of a dead end every so often; a party wedged in a corner walks
    // into the same wall forever and never trips an encounter.
    if (blk % 7 === 6) { n.hold(blk % 2 ? 'right' : 'left', 40); n.run(6); }
  }
  return false;
}

// ── scenarios ──────────────────────────────────────────────────────────────
const SCENARIOS = {};

// The instrument check — a KNOWN ANSWER the resolver must reproduce.
//
// The name grid is pure menu input, and v1.7.873 measured the menu confirm sound
// as $85 by a completely different route (the battle sweep's physical-attack
// control round). So pressing A here must produce $85, and the resolver must
// land it on a ROM site whose own literal is `LDA #$85`. That is a real
// known-answer test: it fails if PC-tagging drifts by even one byte, because
// pc-2 would then point at an operand rather than a store opcode.
//
// It deliberately does NOT assert $b0. An earlier version did, on the assumption
// that "physical attack" always plays ATTACK_HIT — it does not: the starting
// party swings knives and plays $b6. Asserting the wrong known answer would have
// condemned a working instrument.
SCENARIOS.selftest = (rec) => { boot(rec); };

// The opening: FF3 starts with an earthquake that drops the party into the
// Altar Cave. If EARTHQUAKE and FALL fire anywhere, it is here.
SCENARIOS.intro = (rec) => {
  const n = armShots(new Nes(ROM_PATH, { onBatteryRamWrite: rec.hook }), rec);
  rec.nes = n;
  rec.phase = 'title';
  n.run(300);
  for (let i = 0; i < 25; i++) { rec.phase = 'crawl'; n.press('start', 6, 45); }
  rec.phase = 'naming';
  for (let block = 0; block < 10; block++) {
    for (let k = 0; k < 6; k++) n.press('a', 8, 25);
    n.press('down', 8, 40);
  }
  rec.phase = 'post-name';
  n.run(1800);
};

// Field menu: open, move the cursor, provoke a refusal, close.
SCENARIOS.menu = (rec) => {
  const n = boot(rec);
  rec.phase = 'settle';
  n.run(180);
  for (const btn of ['a', 'b', 'start', 'select']) {
    rec.phase = 'open-' + btn;
    n.press(btn, 6, 60);
    rec.phase = 'cursor-' + btn;
    for (let i = 0; i < 6; i++) { n.press('down', 6, 14); n.press('up', 6, 14); }
    rec.phase = 'confirm-' + btn;
    n.press('a', 6, 40);
    rec.phase = 'close-' + btn;
    n.press('b', 6, 30); n.press('b', 6, 30); n.press('b', 6, 40);
  }
};

// Battle: the encounter transition (BATTLE_SWIPE) then flee attempts. FF3's
// escape input is not documented here, so every plausible button and hold is
// tried and the log says which one produced a new site — that is a measurement,
// not a guess about the control scheme.
SCENARIOS.battle = (rec) => {
  const n = boot(rec);
  rec.phase = 'walk';
  if (!reachBattle(n, rec)) throw new Error('never reached a battle');
  rec.phase = 'encounter';
  n.run(180);
  const tries = [['b', 30], ['left', 40], ['right', 40], ['select', 30], ['start', 30]];
  for (const [btn, hold] of tries) {
    rec.phase = 'flee-' + btn;
    n.hold(btn, hold); n.run(90);
    if (spriteCount(n) <= 12) { rec.phase = 'fled-' + btn; n.run(180); break; }
  }
};

/** Hold several buttons at once for n frames (Nes.hold only does one). */
function holdCombo(n, names, frames) {
  const { BTN } = require('./nes.cjs');
  for (const b of names) n.nes.buttonDown(1, BTN[b]);
  n.run(frames);
  for (const b of names) n.nes.buttonUp(1, BTN[b]);
  return n;
}

// FF3's escape input is not written down anywhere in this repo, and guessing at
// a control scheme is how the SIGHT constant stayed wrong for months. So every
// single button and every two-button combo is tried in turn, and the log says
// which one produced the escape sound. That is a measurement of the ROM's
// behaviour, not a recollection of how the game is played.
SCENARIOS.flee = (rec) => {
  const n = boot(rec);
  rec.phase = 'walk';
  if (!reachBattle(n, rec)) throw new Error('never reached a battle');
  n.run(120);
  const B = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right'];
  const combos = [];
  for (const b of B) combos.push([b]);
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) combos.push([B[i], B[j]]);
  }
  let missed = 0;
  for (const c of combos) {
    if (spriteCount(n) <= 12) {                       // battle ended — get another
      rec.phase = 'rewalk';
      if (!reachBattle(n, rec)) { missed++; if (missed > 3) break; continue; }
      n.run(120);
    }
    rec.phase = 'try-' + c.join('+');
    holdCombo(n, c, 50);
    n.run(60);
  }
  console.log(`  [flee] ${combos.length} combos, ${missed} skipped for want of a battle`);
};

// Escape is PROBABILISTIC, so the combo brute-force above proves nothing on its
// own: the right input with an unlucky roll is silent, exactly like the wrong
// input. Two follow-ups, both repeated enough times for a real escape chance to
// land. `left` is the prime suspect — it is the one input that produced the
// error buzz, and "attempt to run / refused" is what an error buzz on a
// direction key means.
SCENARIOS.runmenu = (rec) => {
  const n = boot(rec);
  rec.phase = 'walk';
  if (!reachBattle(n, rec)) throw new Error('never reached a battle');
  n.run(120);

  const ensure = () => {
    if (spriteCount(n) > 12) return true;
    rec.phase = 'rewalk';
    const ok = reachBattle(n, rec);
    if (ok) n.run(120);
    return ok;
  };

  // 1. Hammer LEFT — many attempts across several battles.
  for (let round = 0; round < 6; round++) {
    if (!ensure()) break;
    rec.phase = 'hammer-left-' + round;
    for (let i = 0; i < 30; i++) { n.hold('left', 20); n.run(20); }
  }
  // 2. Walk the command menu by index: down k times, then confirm. If Run is a
  //    menu row rather than a held direction, one of these selects it.
  for (let k = 0; k < 7; k++) {
    for (let round = 0; round < 3; round++) {
      if (!ensure()) break;
      rec.phase = `cmd-${k}-r${round}`;
      for (let i = 0; i < 10; i++) {
        for (let d = 0; d < k; d++) n.press('down', 6, 12);
        n.press('a', 6, 30);
        n.press('a', 6, 30);
      }
    }
  }
};

// The escape sound is guarded by a POLL LOOP, not a menu pick. The ROM at the
// $B3 store reads:
//
//     loop: JSR $F8B0 ... JSR $90D8
//           JSR $8AE6          ; read joypad
//           AND #$20           ; one specific button
//           BEQ loop
//           LDA #$B3 / STA $7F49
//
// so the button has to be held long enough for the loop to sample it, and a
// 50-frame tap during one menu (what `flee` does) can miss entirely. Which
// button bit $20 is stays UNASSUMED — every button is held for a long stretch
// and the log says which one fires it.
SCENARIOS.flee2 = (rec) => {
  const n = boot(rec);
  rec.phase = 'walk';
  if (!reachBattle(n, rec)) throw new Error('never reached a battle');
  n.run(120);
  const HOLD = parseInt(process.env.FLEE_HOLD || '600', 10);
  for (const b of ['select', 'start', 'b', 'a', 'up', 'down', 'left', 'right']) {
    if (spriteCount(n) <= 12) {
      rec.phase = 'rewalk';
      if (!reachBattle(n, rec)) break;
      n.run(120);
    }
    rec.phase = 'hold-' + b;
    holdCombo(n, [b], HOLD);
    n.run(120);
  }
};

// Walk the Altar Cave for a long time, fighting whatever turns up and pressing A
// against the scenery. Chests, doors and stairs are all reached by walking, so
// this is the only way to make those sounds fire without hand-navigating a map
// this harness has no map data for. Deterministic: the direction sequence is a
// fixed pattern, not a random walk, so a rerun reproduces the same log.
SCENARIOS.explore = (rec) => {
  const n = boot(rec);
  const DIRS = ['down', 'right', 'up', 'left', 'down', 'down', 'right', 'right',
                'up', 'left', 'left', 'down', 'right', 'up', 'up', 'left'];
  const BUDGET = parseInt(process.env.EXPLORE_FRAMES || '90000', 10);
  let step = 0;
  while (n.frames < BUDGET) {
    if (spriteCount(n) > 12) {                        // in a fight — swing until it ends
      rec.phase = 'fight';
      for (let i = 0; i < 60 && spriteCount(n) > 12; i++) n.press('a', 6, 20);
      n.run(120);
      continue;
    }
    rec.phase = 'explore';
    const d = DIRS[step % DIRS.length];
    n.hold(d, 14 + (step % 5) * 6);
    n.run(6);
    if (step % 3 === 0) { rec.phase = 'action'; n.press('a', 6, 24); }   // chests, stairs, NPCs
    if (step % 17 === 16) { rec.phase = 'cancel'; n.press('b', 6, 24); }
    step++;
  }
};

// ── main ───────────────────────────────────────────────────────────────────
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = want.length ? want : Object.keys(SCENARIOS);
const all = [];
let selftestOk = null;

for (const name of names) {
  if (!SCENARIOS[name]) { console.error('unknown scenario: ' + name); process.exit(2); }
  const rec = makeRecorder(name);
  let err = null;
  try { SCENARIOS[name](rec); } catch (e) { err = e.message; }
  const rows = summarize(rec.log);
  printRows(rows, name + (err ? `  [ABORTED: ${err}]` : ''));
  if (rec.mapDelta.length) {
    console.log('  within ' + SHOT_AFTER + ' frames after each sound:');
    for (const d of rec.mapDelta) {
      console.log(`    ${d.faded ? 'FADED-TO-BLACK' : 'no fade       '}  ${d.changed ? 'bg-changed' : 'bg-same   '}  ${d.label}`);
    }
  }
  if (rec.watchBattle.length) {
    const agg = new Map();
    for (const w of rec.watchBattle) {
      if (!agg.has(w.value)) agg.set(w.value, { n: 0, hit: 0 });
      const a = agg.get(w.value); a.n++; if (w.sawBattle) a.hit++;
    }
    console.log('  battle on screen within 240 frames after the sound:');
    for (const [v, a] of [...agg.entries()].sort((x, y) => y[1].hit / y[1].n - x[1].hit / x[1].n)) {
      console.log(`    $${v.toString(16).padEnd(3)} ${String(a.hit).padStart(4)}/${String(a.n).padEnd(5)}`
        + ` ${Math.round(100 * a.hit / a.n)}%`);
    }
  }
  all.push({ scenario: name, error: err, rows, shots: rec.shots, mapDelta: rec.mapDelta,
             watchBattle: rec.watchBattle });

  if (name === 'selftest') {
    const checks = [];
    // 1. Known answer: menu confirm is $85, independently measured in v1.7.873,
    //    and must resolve to a site that literally loads $85.
    const confirm = rows.find((r) => r.value === 0x85 && r.site !== null && r.siteImm === 0x85);
    checks.push(['menu A press writes $85 from an LDA #$85 site', !!confirm,
      confirm ? `0x${confirm.site.toString(16)}` : 'not seen']);
    // 2. Every write must resolve, or the resolver is guessing.
    const unresolved = rows.filter((r) => r.site === null);
    checks.push(['every write resolved to a ROM offset', unresolved.length === 0,
      `${rows.length - unresolved.length}/${rows.length}`]);
    // 3. Every resolved offset must actually be a store site in the ROM index.
    const bogus = rows.filter((r) => r.site !== null && !SITES.has(r.site));
    checks.push(['every resolved offset is a known $7F49 store', bogus.length === 0,
      `${bogus.length} bogus`]);
    selftestOk = checks.every((c) => c[1]);
    console.log('');
    for (const [what, ok, detail] of checks) {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what.padEnd(46)} ${detail}`);
    }
    console.log(`  SELFTEST: ${selftestOk ? 'PASS' : 'FAIL'}`);
  }
}

writeFileSync(OUT, JSON.stringify({ rom: ROM_PATH, selftestOk, scenarios: all }, null, 2));
console.log('\nwrote ' + OUT);
if (selftestOk === false) process.exit(1);
