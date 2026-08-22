import fs from 'node:fs'; import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';
const rom = new Uint8Array(fs.readFileSync('FF3-English.nes'));
const SNAP = zlib.gunzipSync(fs.readFileSync('tools/states/ff3-freeroam.state.gz')).toString('utf8');
const nes = new NES({ onFrame(){}, onAudioSample(){} });
nes.loadROM(Buffer.from(rom).toString('binary')); nes.fromJSON(JSON.parse(SNAP));
const run=n=>{for(let i=0;i<n;i++)nes.frame();};
const lines=()=>{const v=nes.ppu.vramMem,out=[];for(let r=0;r<30;r++){let s='';
  for(let c=0;c<32;c++){const g=glyph(v[0x2000+r*32+c]); s+=(g===null?' ':g);} if(s.trim())out.push(s.replace(/\s+/g,' ').trim());}return out;};
const w16=a=>nes.cpu.mem[a]|(nes.cpu.mem[a+1]<<8);
run(30);
// snapshot RAM before the battle so we can find where party stats live
const before = Uint8Array.from(nes.cpu.mem.slice(0, 0x8000));
const D=[Controller.BUTTON_LEFT,Controller.BUTTON_RIGHT,Controller.BUTTON_UP,Controller.BUTTON_DOWN];
let inB=false;
for(let s=0;s<400;s++){const b=D[Math.floor(s/8)%4];
  nes.buttonDown(1,b);run(10);nes.buttonUp(1,b);run(12);
  if(lines().some(l=>/Guard|Item/i.test(l))){inB=true;break;}}
console.log('in battle:', inB);
console.log('screen:'); lines().forEach(l=>console.log('   '+l));
const cur=[0,1,2,3].map(i=>w16(M3.partyAddr(i)));
const max=[0,1,2,3].map(i=>w16(M3.partyAddr(i)+M3.HP_MAX_OFF));
console.log('party cur/max HP:', cur.map((v,i)=>`${v}/${max[i]}`).join('  '));
// where does maxHP live outside battle? scan the pre-battle RAM snapshot
for (const m of new Set(max)) {
  if (!m) continue;
  const hits=[];
  for (let a=0;a<0x7fff;a++) if ((before[a]|(before[a+1]<<8))===m) hits.push('0x'+a.toString(16));
  console.log(`  maxHP ${m} found pre-battle at:`, hits.slice(0,14).join(' '), hits.length>14?`(+${hits.length-14})`:'');
}
