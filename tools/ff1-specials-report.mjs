#!/usr/bin/env node
// ff1-specials-report.mjs — turn the raw sweep JSON into docs/FF1-MONSTER-SPECIALS.md
//
//   node tools/ff1-specials-report.mjs sweep.json > docs/FF1-MONSTER-SPECIALS.md
//
// ⛔ EVERY FILTER IS MEASURED, NOT HAND-WRITTEN. This is the rule the FF3 sweep
// arrived at the hard way: both times a noise list was authored by hand it ate real
// signal (one swallowed Run/Flee/Died, another hid Amon's BarrierShift). So:
//   - the baseline is the word set of a control monster that HAS no special,
//   - monster names come from the ROM's own name table,
//   - a group's signature is the words shared by >=40% of its members, which drops
//     per-monster noise without anyone deciding what counts as noise.

import fs from 'node:fs';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
// Several sweep JSONs may be given; a later file replaces an earlier one's row for
// the same id. That is how the deep pass over special-carrying monsters is layered
// on top of the broad 128-monster pass without re-running the 82 that have none.
const byId = new Map();
for (const p of process.argv.slice(2)) {
  for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) if (r.ok) byId.set(r.id, r);
}
const rows = [...byId.values()].sort((a, b) => a.id - b.id);
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

// ⭐ The byte 1 curve, measured by tools/ff1-rng-stride.mjs on id 0x76 (WarMECH,
// pool $20). Kept as literals because the run is ~90 min of emulation and the
// report regenerates in a second — but they are MEASURED numbers, transcribed
// from that tool's output, never estimated. Re-run it to change them.
const BYTE1_TABLE = `| chance | exact rate from the ROM's RNG table | \`chance/128\` | delta |
|---|---|---|---|
| \`$00\` | 0.00% (0/256) | 0.00% | 0.00pp |
| \`$10\` | 12.89% (33/256) | 12.50% | +0.39pp |
| \`$20\` | 25.39% (65/256) | 25.00% | +0.39pp |
| \`$40\` | 50.39% (129/256) | 50.00% | +0.39pp |
| \`$60\` | 74.61% (191/256) | 75.00% | -0.39pp |
| \`$7F\` | 98.83% (253/256) | 99.22% | -0.39pp |`;
const BYTE1_VERDICT = `⭐ **\`chance/128\` is exact, and no sampling was needed to establish it.** The
roll is \`floor(rand * 129 / 256) < chance\` where \`rand\` is the next byte of the
FIXED 256-byte table at \`$FCF1\`, so the rate is just how many of those 256 bytes
clear the bar — a closed-form count, not an estimate. Swept over ALL 129 legal
chance values, the exact rate never departs from \`chance/128\` by more than
**0.39pp**, which is one table entry out of 256. There is no room in the ROM for
a 1.35x mid-range inflation; the v1.9.11 anomaly was the hang, nothing else.

Empirical check on the corrected setup (\`0x76\`, chance \`$20\`, 10 battles, 300
rounds, **129 rolls**), via \`tools/ff1-rng-stride.mjs\` + \`ff1-rng-stride-analyze.mjs\`:

- fire rate **33.0% ± 7.1pp** vs the exact 25.39% — **z = 1.07, consistent**.
- **129/129** logged bytes equal \`TABLE[idx]\` read straight from the ROM, and
  **129/129** fire outcomes equal \`floor(v*129/256) < chance\`. The model is not
  approximately right, it is exactly right on every roll observed.

⚠ **Rolls inside one battle are NOT independent.** Per-battle rates came out
58/15/58/7/0/46/42/14/31/58% — far past binomial spread. A battle walks one RNG
stream, so the honest bar is battle-clustered (±7.1pp); treating all 129 rolls as
independent would claim ±3.8pp and overstate confidence by ~1.9x. Any future
FF1 rate measurement has this property and must cluster by battle.

⚠ **Visited RNG indices are genuinely non-uniform** — odd indices outnumber even
**93 to 36** (chi2 = 30.8, df = 7, p < 0.05). So a stride-like structure is real,
just not the one v1.9.11 guessed. It also cannot be the missing explanation: the
odd-index subset scores **21.9%** at chance \`$20\`, *below* nominal, so the bias
pushes the rate DOWN. Every mechanism found so far moves the wrong way.

⚠ **Scope.** Only chance \`$20\` was measured in-battle (each battle is ~5 min of
emulation). The other rows rest on the closed-form table count, which carries no
sampling error — but they are computed, not observed.`;

const nameOf = (id) => MN.monsterName(rom, id, F1.glyph) || `#${hx(id)}`;
// Every monster name in the game, so a name never reads as behaviour.
const NAMES = new Set();
for (let id = 0; id < MN.NAME_COUNT; id++) {
  const n = nameOf(id);
  if (n) { NAMES.add(n); for (const part of n.split(/[^A-Za-z']+/)) if (part.length > 2) NAMES.add(part); }
}

// ⭐ Baseline: a monster the ROM says has NO special (byte 7 = 0xFF). Whatever
// appears in its fight is the frame around every fight — menu text, hit/miss
// messages, the party panel.
const ctl = rows.find(r => r.special === MN.NO_SPECIAL);
const BASELINE = new Set(ctl ? ctl.words : []);

const clean = (ws) => ws.filter(w => !BASELINE.has(w) && !NAMES.has(w));

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.special)) groups.set(r.special, []);
  groups.get(r.special).push(r);
}

const SIG = 0.4;
const lines = [];
lines.push('# FF1 monster special attacks — stat byte 7');
lines.push('');
lines.push('Swept from the running game: every monster spawned alone, evade forced to');
lines.push('`0xFF` and current HP pinned every sample so it survives to act, then the battle');
const deep = rows.filter(r => r.special !== MN.NO_SPECIAL);
const maxR = Math.max(...deep.map(r => r.rounds), 0);
lines.push(`text read for up to ${maxR} rounds on the ${deep.length} monsters that carry a special.`);
lines.push(`**${rows.length}/128 fought.**`);
lines.push('');
lines.push('Byte 7 is the special id; `0xFF` means the monster has none.');
lines.push('');
lines.push('⛔ Signature words are those seen in **≥40%** of the monsters sharing a value, so');
lines.push('per-monster noise drops out. Groups of one keep everything they showed; marked ⚠.');
lines.push('⛔ The baseline subtracted is a **measured** control fight (a `0xFF` monster), and');
lines.push("monster names come from the ROM's own name table — neither list is hand-written.");
lines.push('');
lines.push('⛔ **Coverage limit.** The monster is unkillable during the sweep (evade `0xFF`,');
lines.push('HP pinned). A special gated on low HP, or on a party member dying, cannot fire');
lines.push('under these conditions — so an empty row means *nothing observed while healthy*,');
lines.push('not *no special exists*. The FF3 sweep has the same property.');
lines.push('');
lines.push('## What byte 7 actually selects');
lines.push('');
lines.push('Byte 7 is **not** an attack — it indexes a 16-byte pool entry at');
lines.push('`$9020 + byte7*16` (bank 12, file `$31030`), and the monster picks from a list:');
lines.push('');
lines.push('```');
lines.push('  +0        chance for list A     +1        chance for list B');
lines.push('  +2..+9    list A: 8 entries      +11..+14  list B: 4 entries');
lines.push('  +10       $FF separator          +15       $FF separator');
lines.push('');
lines.push('  pool $22 (LICH):  60 00 | 1F 1C 1D 16 15 14 0F 05 | FF x6');
lines.push('```');
lines.push('');
lines.push('The gate, disassembled in the bank the CPU actually had mapped:');
lines.push('');
lines.push('```');
lines.push('  B2A8  LDA ($9C),Y  Y=7      ; byte 7; $FF -> no special');
lines.push('  B2B3  JSR $AE09    X=$10    ; id * 16');
lines.push('  B2B7  ADC #$20 / ADC #$90   ; pointer = $9020 + id*16');
lines.push('  B2C2  LDA ($9E),Y  Y=0      ; byte 0 = the chance');
lines.push('  B2C4  JSR $B294             ; random(0..128); CMP chance');
lines.push('  B2C7  BCS $B2EF             ; random >= chance -> skip');
lines.push('  B2CB  LDA ($9A),Y / AND #$07 / ADC #$02   ; counter mod 8 -> list index');
lines.push('```');
lines.push('');
lines.push('`$AE5D` scales the roll: `value = floor(rand * 129 / 256)`, fired when');
lines.push('`value < chance`. And `rand` is not computed — FF1\'s RNG is a **fixed 256-byte');
lines.push('table at `$FCF1`** indexed by a counter at `$688A` (`$FCE7: LDX $688A / INC');
lines.push('$688A / LDA $FCF1,X`). So the exact rate is countable from the ROM, and the');
lines.push('table is uniform enough that it reduces to **chance / 128**.');
lines.push('');
lines.push('Measured by counting the branch outcome directly — a read of `+0` is one roll,');
lines.push('a read of `+2..+9` is a pass — over 14 independent battles per row:');
lines.push('');
lines.push('| byte 0 | n rolls | fires | measured | exact from the ROM table |');
lines.push('|---|---|---|---|---|');
lines.push('| `$00` | 111 | 0 | 0.0% | 0.0% |');
lines.push('| `$10` | 108 | 15 | 13.9% | 12.9% |');
lines.push('| `$20` | 96 | 18 | 18.8% | 25.4% |');
lines.push('| `$40` | 87 | 44 | 50.6% | 50.4% |');
lines.push('| `$60` | 113 | 88 | 77.9% | 74.6% |');
lines.push('| `$7F` | 110 | 109 | 99.1% | 98.8% |');
lines.push('');
lines.push('Five of six rows land within ~3 points of the value computed from the ROM table.');
lines.push('**The rate is `chance / 128`.**');
lines.push('');
lines.push('⚠ **The per-row sigma here is overstated.** These rows treat every roll as an');
lines.push('independent sample; the byte 1 work below measures that rolls CLUSTER within a');
lines.push('battle, widening the real error bar by ~1.9x. So `$20` sitting "1.5 sigma low"');
lines.push('is really under 1 sigma — the agreement is looser than it looks, but the');
lines.push('conclusion is unchanged because the exact ROM-table count needs no sampling at');
lines.push('all. Re-running this curve with battle-clustered bars is the outstanding work.');
lines.push('');
lines.push('⛔ **An earlier version of this table was wrong and is retracted.** It reported');
lines.push('0 / 38 / 71 / 89 / 100% off 4-9 rolls per row. Those were not independent');
lines.push('samples: the RNG table above is not seeded from frames or input, so every battle');
lines.push('replayed the SAME stream and repeated runs came out byte-identical. Independent');
lines.push('samples require seeding `$688A` per battle, which is what `ff1-rate-curve.mjs`');
lines.push('now does. Any harness that restarts from a savestate has this problem.');
lines.push('⛔ `$FF` in byte 0 yields 0%, matching the table\'s use of `$FF` as "empty"');
lines.push('rather than "always".');
lines.push('⭐ The `AND #$07` is why a pool cycles: LICH cast `1F 1C 1D` — the first three');
lines.push('entries of its own list, in order — rather than repeating one attack.');
lines.push('');
lines.push('### Byte 1 — the second list');
lines.push('');
lines.push('The entry holds **two parallel lists**, each with its own chance byte. Byte 1');
lines.push('gates a 4-entry list at `+11..+14`, reached only when list A\'s roll FAILS:');
lines.push('');
lines.push('```');
lines.push('  B2EF  LDY #$01 / LDA ($9E),Y   ; byte 1 = chance for list B');
lines.push('  B2F3  JSR $B294                ; the SAME roll routine as list A');
lines.push('  B2F6  BCS $B319                ; fail -> no attack at all');
lines.push('  B2FA  LDA ($9A),Y  Y=8         ; a SEPARATE counter (list A uses Y=7)');
lines.push('  B2FC  AND #$03                 ; mod 4, not mod 8');
lines.push('  B301  ADC #$0B                 ; +11 = start of list B');
lines.push('  B304  LDA ($9E),Y / CMP #$FF   ; $FF entry -> reset counter, retry');
lines.push('  B314  ADC #$42                 ; ⭐ list B ids are OFFSET BY $42');
lines.push('```');
lines.push('');
lines.push('⭐ Because `$B2C7 BCS $B2EF` falls through from list A, a monster carrying both');
lines.push('lists uses list B at **`(1 - a/128) * (b/128)`**, not `b/128`.');
lines.push('');
lines.push('⭐ **List B ids are not spell ids.** `$B314 ADC #$42` shifts every list B entry');
lines.push('into `$42..$5B` before dispatch, so the two lists index DIFFERENT tables —');
lines.push('list A holds spell ids `$00..$3F`, list B holds skill ids `$42..$5B`. This is');
lines.push('why STINGER, INK and NUCLEAR were never findable in the `$81E0` spell table:');
lines.push('they were never in it. Pools `$21`, `$26`, `$28`, `$29` looked "broken" for');
lines.push('the same reason — they carry no list A at all.');
lines.push('');
lines.push('⛔ **AN ALL-`$FF` LIST IS AN INFINITE LOOP.** `$B30A` resets the counter and');
lines.push('jumps back to `$B2F8` whenever the indexed entry is `$FF`; if every slot is');
lines.push('`$FF`, the ROM never leaves. The stock game never reaches it — chance is 0');
lines.push('exactly when the list is empty, in all 44 pools — but PATCHING a chance byte');
lines.push('over an empty list hangs the game. `ff1-rng-stride.mjs` now refuses that');
lines.push('configuration instead of measuring a frozen emulator.');
lines.push('');
lines.push('Structural check across all 44 pool entries, **zero mismatches**: `byte 0 != 0`');
lines.push('iff `+2..+9` is populated, `byte 1 != 0` iff `+11..+14` is populated, and `+10`');
lines.push('and `+15` are always `$FF`.');
lines.push('');
lines.push('#### ⛔ The v1.9.11 byte 1 curve is RETRACTED');
lines.push('');
lines.push('It was published as "measured on WarMECH (pool `$20`)". It was not.');
lines.push('`ff1-rate-curve.mjs` defaults to `--id 0x77`, the run used the default, and');
lines.push('`0x77` is **LICH, pool `$22`** — `byte 0 = $60` and list B `FF FF FF FF`.');
lines.push('Patching byte 1 non-zero there walked straight into the `$FF` retry loop');
lines.push('above: one battle logged **12,332,381 reads of `+11`**. The emulator hung');
lines.push('after the first roll, so every row of that table was counted off a frozen');
lines.push('game. The reported n was meaningless and so was the "~1.35x mid-range"');
lines.push('anomaly built on it — along with the strided-RNG hypothesis invented to');
lines.push('explain it. WarMECH is `0x76`. The catalog table below had the right pool for');
lines.push('`0x76` the whole time; only the prose was wrong.');
lines.push('');
lines.push('The correct isolator is **`0x76` WarMECH, pool `$20`** — `byte 0 = 00` (list A');
lines.push('can never fire) AND all four list B slots populated (no retry path, so one list');
lines.push('read == one fire). The table below is **computed from the ROM, not sampled**:');
lines.push('');
lines.push(BYTE1_TABLE);
lines.push('');
lines.push(BYTE1_VERDICT);
lines.push('');
lines.push('| byte 7 | monsters | behaviour (names + baseline stripped) | example |');
lines.push('|---|---|---|---|');

const keys = [...groups.keys()].sort((a, b) => a - b);
for (const k of keys) {
  const g = groups.get(k);
  const counts = new Map();
  for (const r of g) for (const w of new Set(clean(r.words))) counts.set(w, (counts.get(w) || 0) + 1);
  const sig = [...counts.entries()]
    .filter(([, n]) => g.length === 1 || n / g.length >= SIG)
    .sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const grew = g.filter(r => r.multiplied);
  const tag = grew.length ? `**${grew.length}/${g.length} MULTIPLY** ` : '';
  const label = k === MN.NO_SPECIAL ? '`none`' : `\`0x${hx(k)}\``;
  lines.push(`| ${label} | ${g.length}${g.length === 1 ? ' ⚠' : ''} | ${tag}${sig.slice(0, 8).join(' ') || '—'} | ${nameOf(g[0].id)} |`);
}

lines.push('');
lines.push(`${rows.length} monsters, ${keys.filter(k => k !== MN.NO_SPECIAL).length} distinct special ids ` +
           `(${groups.get(MN.NO_SPECIAL)?.length ?? 0} monsters have none).`);
lines.push('');
lines.push('## Per-monster');
lines.push('');
lines.push('| id | monster | byte 7 | status | rounds | behaviour |');
lines.push('|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| \`${hx(r.id)}\` | ${nameOf(r.id)} | ${r.special === MN.NO_SPECIAL ? '—' : '`0x' + hx(r.special) + '`'} | \`${hx(r.status)}\` | ${r.rounds} | ${clean(r.words).slice(0, 8).join(' ') || '—'} |`);
}
console.log(lines.join('\n'));
