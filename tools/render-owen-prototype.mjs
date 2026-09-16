#!/usr/bin/env node
// Review images from the actual renderer and native Owen assets. No drawn-over
// geometry: annotations occupy a separate strip below each full-floor image.
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document={createElement:()=>createCanvas(8,8),getElementById:()=>null,addEventListener(){},fonts:{load:async()=>[]}};
globalThis.window={addEventListener(){},matchMedia:()=>({matches:false})};
globalThis.requestAnimationFrame=fn=>fn();
globalThis.localStorage={getItem:()=>null,setItem(){}};
const {generateFloor}=await import('../src/dungeon-generator.js');
const {DUNGEONS}=await import('../src/data/dungeons.js');
const OWEN=DUNGEONS.find(d=>d.id==='owen');
const {applyFeature}=await import('../src/dungeons/compile.js');
const {bossFramesForDungeon}=await import('../src/dungeon/boss-chamber.js');
const {initMapObjectFrames}=await import('../src/sprite-init.js');
const {buildSpritePalettes,parseMapProperties}=await import('../src/map-loader.js');
const {MapRenderer}=await import('../src/map-renderer.js');
const {Sprite,DIR_DOWN}=await import('../src/sprite.js');
const {initSpriteAssets}=await import('../src/boot.js');
const {SPRITE_PAL_TOP,SPRITE_PAL_BTM}=await import('../src/job-sprites.js');
const {applyIPS}=await import('../src/ips-patcher.js');
const rom=fs.readFileSync(new URL('../FF3-English.nes',import.meta.url));
applyIPS(rom,fs.readFileSync(new URL('../patches/ff3-awj.ips',import.meta.url)));
initSpriteAssets(rom);
const sprite=new Sprite(rom,SPRITE_PAL_TOP,SPRITE_PAL_BTM);sprite.setDirection(DIR_DOWN);
const out='/tmp/ff3mmo-owen-prototype';fs.mkdirSync(out,{recursive:true});
const seed=1754900087109;
for(const [floor,opened,label]of [[0,false,'gallery-closed'],[0,true,'gallery-open'],[1,false,'distribution'],[2,false,'shaft'],[3,false,'control'],[4,false,'engine']]){
  const map=generateFloor(rom,floor,seed,OWEN);
  if(opened)applyFeature(map,map.features.find(f=>f.kind==='passage'),OWEN);
  const renderer=new MapRenderer(map,map.entranceX,map.entranceY);
  const full=createCanvas(256,224),ctx=full.getContext('2d');
  ctx.drawImage(renderer._mapCanvas,0,0);
  if (floor===4) ctx.drawImage(bossFramesForDungeon(rom,OWEN,initMapObjectFrames,buildSpritePalettes,parseMapProperties)[0],6*16,8*16);
  sprite.draw(ctx,map.entranceX*16,map.entranceY*16);
  const review=createCanvas(768,720),r=review.getContext('2d');r.imageSmoothingEnabled=false;
  r.fillStyle='#101318';r.fillRect(0,0,768,720);r.drawImage(full,0,0,768,672);
  r.fillStyle='#ede6d0';r.font='18px monospace';r.fillText(`${map.sectionName} | ${opened?'service gate OPEN':'initial state'} | seed ${seed}`,12,701);
  fs.writeFileSync(`${out}/owen-${label}.png`,review.toBuffer('image/png'));
  // 9x9-tile viewport, matching the game's documented field window.
  const camera=createCanvas(144,144),c=camera.getContext('2d');
  const focus= [[8,7],[8,7],[3,7],[8,5],[10,8]][floor];
  const wx=focus[0]*16-64,wy=focus[1]*16-64;
  c.drawImage(renderer._mapCanvas,-wx,-wy);
  if(floor===4)c.drawImage(bossFramesForDungeon(rom,OWEN,initMapObjectFrames,buildSpritePalettes,parseMapProperties)[0],6*16-wx,8*16-wy);
  sprite.draw(c,64,64);
  const zoom=createCanvas(576,576),z=zoom.getContext('2d');z.imageSmoothingEnabled=false;z.drawImage(camera,0,0,576,576);
  fs.writeFileSync(`${out}/owen-${label}-camera.png`,zoom.toBuffer('image/png'));
}
console.log(`Owen PNGs: ${out}/owen-{gallery-closed,gallery-open,distribution,shaft,control,engine}{,-camera}.png`);
