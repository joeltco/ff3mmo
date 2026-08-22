import fs from 'node:fs'; import zlib from 'node:zlib';
import { NES } from 'jsnes';
const rom = new Uint8Array(fs.readFileSync('FF3-English.nes'));
const SNAP = zlib.gunzipSync(fs.readFileSync('tools/states/ff3-freeroam.state.gz')).toString('utf8');
const nes = new NES({ onFrame(){}, onAudioSample(){} });
nes.loadROM(Buffer.from(rom).toString('binary')); nes.fromJSON(JSON.parse(SNAP));
for(let i=0;i<30;i++)nes.frame();
const m = nes.cpu.mem;
for (let p=0;p<4;p++){
  const b=0x6100+p*0x40;
  let s=`slot${p} @0x${b.toString(16)}: `;
  for(let k=0;k<0x40;k++) s += m[b+k].toString(16).padStart(2,'0') + (k%16===15?'\n            ':' ');
  console.log(s);
}
