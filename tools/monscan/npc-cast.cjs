// npc-cast.cjs — WHO THE GAME ACTUALLY DRAWS on a map, read off the running
// engine, in whichever story state you ask for.
//
// ── why this exists ───────────────────────────────────────────────────────
// Every other NPC tool reads the cartridge's per-map record table ({id,x,y,
// flags} at $058010) and treats it as the cast. It is not. Each record is
// gated by a PER-NPC-ID VISIBILITY BITMAP, and on a fresh game roughly half of
// Kazus and Castle Sasune is switched off:
//
//     test (bank $3B $B51A):  $6080 + (id >> 3),  bit 1 << (id & 7)
//                             $78 != 0  ->  the second bank at $60A0
//     bit CLEAR -> the record's id is overwritten with 0 and NOT DRAWN
//     init      -> $6080..$60BF copied from ROM file offset 0x1610 on new game
//     opcodes   -> $F4 <id> shows an NPC, $F5 <id> hides one
//
// So "the ROM lists 6 people in this room" answers a different question than
// "6 people are in this room when the player walks in".
//
// This boots the real game (the monscan choreography + the 1-HP-goblin field
// ROM so the opening battle ends), warps with the ROM's own go-to-map path,
// then reads the ENGINE'S OWN resolved slot table rather than re-deriving it:
//
//     base $7000, 16 bytes per slot   (LDA #$00/STA $8E, LDA #$70/STA $8F)
//     +0x00 the id it settled on — 0 means the visibility bit was clear
//     +0x02 X   +0x03 Y   +0x0A the original id from the cartridge record
//
// ⛔ The bitmap is SRAM, so it only exists after a real boot. Warping a cold
// machine gives all zeros, which reads exactly like "everyone is hidden".
// The run prints $6084 so a patched cartridge can be told from a stock one.
//
//   ROM=field.nes MAPS=10,12,25 node tools/monscan/npc-cast.cjs
//   ROM=field-lifted.nes MAPS=29 SHOT=/tmp/x node tools/monscan/npc-cast.cjs
//
// Build the field ROM with tools/monscan/build-field-rom.cjs. To ask what a
// town looks like in a LATER story state, hex-patch the init table at 0x1610
// and pass the patched ROM — the game will not hand that state over headlessly,
// the cartridge will.
const { Nes, BTN } = require('./nes.cjs');
const ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const MAPS = (process.env.MAPS || process.argv[2] || '10')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));

function run(n, nes) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 8, a = 24) {
  nes.nes.buttonDown(1, BTN[b]); run(h, nes);
  nes.nes.buttonUp(1, BTN[b]); run(a, nes);
}
function inBattle(nes) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++;
  return c > 12;
}
function bootToWorld(nes) {
  run(300, nes);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
  run(400, nes);
  // The field ROM's goblin dies to one hit. Without this the harness sits in
  // the opening battle and every reading below describes the battle screen.
  for (let i = 0; i < 80 && inBattle(nes); i++) press(nes, 'a', 8, 30);
}
function warp(nes, mapId, hold = 300) {
  const cpu = nes.nes.cpu;
  for (let f = 0; f < hold; f++) {
    cpu.mem[0x0700] = mapId & 0xFF;
    cpu.mem[0x00AB] = 0x80;
    nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) { run(90, nes); return true; }
  }
  return false;
}

for (const mapId of MAPS) {
  const nes = new Nes(ROM);
  bootToWorld(nes);
  const peek = (a) => nes.nes.cpu.mem[a] & 0xFF;
  if (inBattle(nes)) { console.log(`map ${mapId}: still in a battle — skipped`); continue; }
  const took = warp(nes, mapId);
  run(120, nes);
  const hex = (v) => '$' + v.toString(16).padStart(2, '0');
  console.log(`\nmap ${mapId}: warp ${took ? 'accepted' : 'NOT ACCEPTED — result is meaningless'}` +
    `   bitmap $6080..$6087 = ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => peek(0x6080 + i).toString(16).padStart(2, '0')).join(' ')}`);
  let drawn = 0, hidden = 0;
  for (let i = 0; i < 16; i++) {
    const b = 0x7000 + i * 16;
    const id = peek(b), x = peek(b + 2), y = peek(b + 3), orig = peek(b + 0x0A);
    if (orig === 0 && id === 0) continue;
    if (id) drawn++; else hidden++;
    console.log(`  slot${String(i).padStart(2)}  rom=${hex(orig)} @(${x},${y})  ` +
      (id ? `DRAWN as ${hex(id)}` : 'hidden'));
  }
  console.log(`  ${drawn} drawn, ${hidden} hidden`);
  if (process.env.SHOT) nes.screenshot(`${process.env.SHOT}/cast-${mapId}.png`);
}
