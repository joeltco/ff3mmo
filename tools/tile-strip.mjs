import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM));
const start = parseInt(process.argv[2],16), count = parseInt(process.argv[3],10);
const COLS=16, SC=5, CELL=8, LBL=9;
const rows=Math.ceil(count/COLS);
const cv=createCanvas(COLS*CELL*SC, rows*(CELL*SC+LBL));
const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
g.fillStyle='#202030'; g.fillRect(0,0,cv.width,cv.height);
const PAL=[[32,32,48],[255,255,255],[200,40,20],[120,120,120]];
for(let n=0;n<count;n++){
  const off=start+n*16, col=n%COLS, row=(n/COLS)|0;
  const ox=col*CELL*SC, oy=row*(CELL*SC+LBL)+LBL;
  const img=g.createImageData(CELL,CELL);
  for(let y=0;y<8;y++){const lo=rom[off+y],hi=rom[off+8+y];
    for(let x=0;x<8;x++){const b=7-x;const v=((lo>>b)&1)|(((hi>>b)&1)<<1);
      const c=PAL[v]; const i=(y*CELL+x)*4;
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=255;}}
  const tmp=createCanvas(CELL,CELL); tmp.getContext('2d').putImageData(img,0,0);
  g.drawImage(tmp,0,0,CELL,CELL,ox,oy,CELL*SC,CELL*SC);
  if(col===0){g.fillStyle='#c8a832';g.font='8px monospace';
    g.fillText('0x'+off.toString(16), ox+1, oy-1);}
}
fs.writeFileSync(process.argv[4], cv.toBuffer('image/png'));
console.log(`${count} tiles from 0x${start.toString(16)} -> ${process.argv[4]}`);
