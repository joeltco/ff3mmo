#!/usr/bin/env node
// ff3-pc-probe.mjs — did a given instruction actually EXECUTE, in the bank we mean?
//
// WHY THE BANK CHECK IS THE WHOLE POINT
// `$8000-$DFFF` is MMC3-banked, so a CPU address does not identify code. Counting
// executions by PC alone is worthless: probing bank 53's routine this way reported
// 48 hits at its entry and 20 at its byte-15 read — and ⛔ EVERY ONE was a
// different bank's code sitting at the same address. Verified against the opcode
// bytes, both are ZERO.
//
//   node tools/ff3-pc-probe.mjs
//
// ⛔ Always include a site you KNOW runs. Here `$A5F2` (the byte-15 store, which
// the differential tracer independently proves executes twice, once per monster)
// is the control: raw 2, verified 2. A probe whose control does not fire cannot
// support a negative.

import fs from "node:fs"; import zlib from "node:zlib"; import { NES, Controller } from "jsnes";
const { glyph } = await import("./lib/ff3-text.mjs");
import * as M3 from "./lib/ff3-monsters.mjs";
const rom=new Uint8Array(fs.readFileSync("./FF3-English.nes"));
const SNAP=zlib.gunzipSync(fs.readFileSync("tools/states/ff3-freeroam.state.gz")).toString("utf8");
const D=[Controller.BUTTON_LEFT,Controller.BUTTON_RIGHT,Controller.BUTTON_UP,Controller.BUTTON_DOWN];
/** Count executions of `pc`, but ONLY when the bytes there are `want` — i.e. when
 *  the bank we mean is actually mapped. Without this, another bank's code at the
 *  same CPU address counts as a hit. */
function count(sites, rounds=4){
  const p=Uint8Array.from(rom);
  p[M3.MONSTER_PROPS+1]=0xFF; p[M3.MONSTER_PROPS+2]=0x7F;
  const nes=new NES({onFrame:()=>{},onAudioSample:()=>{}});
  nes.loadROM(Buffer.from(p).toString("binary")); nes.fromJSON(JSON.parse(SNAP));
  const raw={}, ok={}; for(const s of sites){raw[s.name]=0; ok[s.name]=0;}
  const cpu=nes.cpu, orig=cpu.emulate.bind(cpu);
  cpu.emulate=()=>{
    for(const s of sites){
      if(cpu.REG_PC===s.pc||cpu.REG_PC===s.pc-1){
        raw[s.name]++;
        if(s.want.every((b,i)=>cpu.mem[s.pc+i]===b)) ok[s.name]++;
      }
    }
    return orig();
  };
  const run=(n)=>{for(let i=0;i<n;i++)nes.frame();};
  const tx=()=>{const v=nes.ppu.vramMem;const o=[];for(let r=0;r<30;r++){let s="";for(let c=0;c<32;c++){const g=glyph(v[0x2000+r*32+c]);s+=(g===null?" ":g);}if(s.trim())o.push(s.replace(/\s+/g," ").trim());}return o;};
  const mage=()=>{for(let i=0;i<4;i++){const a=0x6100+i*0x40,b=0x6200+i*0x40;
    nes.cpu.mem[a]=4; for(let k=0;k<8;k++) nes.cpu.mem[b+0x07+k]=0x31;
    for(let k=0;k<16;k++) nes.cpu.mem[a+0x30+k]=99;}};
  const tap=(btn,h=10,g=24)=>{nes.buttonDown(1,btn);run(h);nes.buttonUp(1,btn);run(g);};
  run(30); mage();
  for(let s=0;s<400;s++){mage();const b=D[Math.floor(s/8)%4];
    nes.buttonDown(1,b);run(10);nes.buttonUp(1,b);run(12);
    if(tx().some(l=>/Magic/i.test(l)))break;}
  for(let r=0;r<rounds;r++){
    for(let c=0;c<4;c++){ tap(Controller.BUTTON_DOWN); tap(Controller.BUTTON_A,10,45);
      for(let k=0;k<6;k++) tap(Controller.BUTTON_DOWN,10,18);
      tap(Controller.BUTTON_A,10,45); tap(Controller.BUTTON_A,10,45); }
    run(300);
  }
  return {raw,ok};
}
const sites=[
  {name:"$A5F2 STA — the byte-15 WRITE (control)", pc:0xA5F2, want:[0x91,0x5D]},
  {name:"$AB9F     — the routine entry",           pc:0xAB9F, want:[0xA9,0x0E]},
  {name:"$ABDE     — the byte-15 READ",            pc:0xABDE, want:[0xA0,0x36]},
];
const {raw,ok}=count(sites);
console.log("executions, raw PC match vs BANK-VERIFIED:\n");
for(const s of sites) console.log(`   ${s.name.padEnd(42)} raw ${String(raw[s.name]).padStart(4)}   verified ${String(ok[s.name]).padStart(4)}`);
