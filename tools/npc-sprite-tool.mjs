// NPC sprite tool — locate + render FF3 walk-sprite bundles for npc.js wiring.
// Builds romRaw = Japan ROM + ff3-awj.ips (matches the in-game ROM byte-for-byte).
//   render <hexoff> [palTop] [palBtm] : decode the 16-tile (256-byte) bundle at a
//        header-inclusive offset, laid out DOWN / UP / LEFT-f0 / LEFT-f1 (Sprite
//        class order), to a PPM. Palettes are comma hex, default = scene pal.
//   search <hexbytes...> : byte-find a tile-byte sequence (from an OAM dump).
import fs from 'node:fs';

const ROM = 'Final Fantasy III (Japan).nes';
const IPS = 'patches/ff3-awj.ips';
function applyIPS(rom, ips) {
  let i = 5;
  while (i + 3 <= ips.length) {
    if (ips[i] === 0x45 && ips[i+1] === 0x4F && ips[i+2] === 0x46) break;
    const off = (ips[i]<<16)|(ips[i+1]<<8)|ips[i+2]; i += 3;
    const size = (ips[i]<<8)|ips[i+1]; i += 2;
    if (size === 0) { const rl=(ips[i]<<8)|ips[i+1]; const v=ips[i+2]; i+=3;
      for (let j=0;j<rl;j++) if (off+j<rom.length) rom[off+j]=v;
    } else { for (let j=0;j<size;j++) if (off+j<rom.length) rom[off+j]=ips[i+j]; i+=size; }
  }
  return rom;
}
function buildRom() {
  const rom = new Uint8Array(fs.readFileSync(ROM));
  return applyIPS(rom, new Uint8Array(fs.readFileSync(IPS)));
}
const NES = [[84,84,84],[0,30,116],[8,16,144],[48,0,136],[68,0,100],[92,0,48],[84,4,0],[60,24,0],[32,42,0],[8,58,0],[0,64,0],[0,60,0],[0,50,60],[0,0,0],[0,0,0],[0,0,0],[152,150,152],[8,76,196],[48,50,236],[92,30,228],[136,20,176],[160,20,100],[152,34,32],[120,60,0],[84,90,0],[40,114,0],[8,124,0],[0,118,40],[0,102,120],[0,0,0],[0,0,0],[0,0,0],[236,238,236],[76,154,236],[120,124,236],[176,98,236],[228,84,236],[236,88,180],[236,106,100],[212,136,32],[160,170,0],[116,196,0],[76,208,32],[56,204,108],[56,180,204],[60,60,60],[0,0,0],[0,0,0],[236,238,236],[168,204,236],[188,188,236],[212,178,236],[236,174,236],[236,174,212],[236,180,176],[228,196,144],[204,210,120],[180,222,120],[168,226,144],[152,226,180],[160,214,228],[160,162,160],[0,0,0],[0,0,0]];
function decodeTile(rom, off) {
  const px = new Uint8Array(64);
  for (let y=0;y<8;y++){ const lo=rom[off+y], hi=rom[off+y+8];
    for(let x=0;x<8;x++){ const b=7-x; px[y*8+x]=((lo>>b)&1)|(((hi>>b)&1)<<1); } }
  return px;
}
const cmd = process.argv[2];
const rom = buildRom();
if (cmd === 'render') {
  const offStr = process.argv[3];
  const off = parseInt(offStr, 16);
  const palTop = (process.argv[4]||'0x1A,0x0F,0x27,0x30').split(',').map(s=>parseInt(s,16));
  const palBtm = (process.argv[5]||'0x1A,0x0F,0x12,0x36').split(',').map(s=>parseInt(s,16));
  const SCALE=6, GAP=8, cellW=16;
  const W=(cellW*4+GAP*3)*SCALE, H=16*SCALE;
  const buf=Buffer.alloc(W*H*3); // black bg
  const pos=[[0,0],[8,0],[0,8],[8,8]];
  for (let grp=0; grp<4; grp++){
    const baseX=(grp*(cellW+GAP))*SCALE;
    for (let t=0;t<4;t++){
      const px=decodeTile(rom, off + (grp*4+t)*16);
      const pal=t<2?palTop:palBtm;
      for(let y=0;y<8;y++)for(let x=0;x<8;x++){
        const ci=px[y*8+x]; if(ci===0) continue;
        const [r,g,b]=NES[pal[ci]&0x3F];
        for(let sy=0;sy<SCALE;sy++)for(let sx=0;sx<SCALE;sx++){
          const dx=baseX+(pos[t][0]+x)*SCALE+sx, dy=(pos[t][1]+y)*SCALE+sy;
          const k=(dy*W+dx)*3; buf[k]=r;buf[k+1]=g;buf[k+2]=b;
        }
      }
    }
  }
  const out=`/tmp/npc-${offStr.replace('0x','')}.ppm`;
  const hdr=Buffer.from(`P6\n${W} ${H}\n255\n`);
  fs.writeFileSync(out, Buffer.concat([hdr,buf]));
  console.log('wrote',out,'| groups L→R: DOWN  UP  LEFT-f0  LEFT-f1');
} else if (cmd === 'search') {
  const needle = process.argv.slice(3).map(s=>parseInt(s,16));
  const hits=[];
  for (let i=0;i<=rom.length-needle.length;i++){
    let ok=true; for(let j=0;j<needle.length;j++) if(rom[i+j]!==needle[j]){ok=false;break;}
    if(ok) hits.push(i);
  }
  console.log('needle len',needle.length,'hits:', hits.map(h=>'0x'+h.toString(16)).join(', ')||'NONE');
} else { console.log('usage: render <hexoff> [palTop] [palBtm] | search <hexbytes...>'); }
