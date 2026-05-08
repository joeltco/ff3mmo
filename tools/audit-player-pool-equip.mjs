// Equipment audit — for every PLAYER_POOL entry, verify each equipped item's
// `jobs` mask actually contains the entry's jobIdx. Fails loud on any
// mismatch. Run from project root: `node tools/audit-player-pool-equip.mjs`
//
// Run this whenever you touch PLAYER_POOL or items.js. Catches the kind of
// "BM wields a Staff but Bw isn't in the Staff mask" drift that lived in
// the pool from v1.7.126 → v1.7.133 before the audit pass caught it.
import { PLAYER_POOL } from '../src/data/players.js';
import { ITEMS } from '../src/data/items.js';

let fails = 0;
for (const p of PLAYER_POOL) {
  const jobBit = 1 << p.jobIdx;
  const slots = ['weaponR', 'weaponL', 'armorId', 'helmId', 'shieldId'];
  for (const slot of slots) {
    const id = p[slot];
    if (id == null || id === 0) continue;
    const item = ITEMS.get(id);
    if (!item) { console.log(`FAIL ${p.name}.${slot}=$${id.toString(16)}: item not in catalog`); fails++; continue; }
    if (!(item.jobs & jobBit)) {
      console.log(`FAIL ${p.name} (jobIdx ${p.jobIdx}).${slot}=$${id.toString(16)} (${item.subtype}): mask doesn't include this job`);
      fails++;
    }
  }
}
console.log(fails === 0 ? `\n✓ All ${PLAYER_POOL.length} entries pass the equipment-mask audit.` : `\n${fails} failure(s).`);
process.exit(fails === 0 ? 0 : 1);
