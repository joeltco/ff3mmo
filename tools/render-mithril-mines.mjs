#!/usr/bin/env node
// Native game-camera views of the authored Mines and their revealed passage.
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(8,8), getElementById: () => null, addEventListener() {}, fonts: { load: async () => [] } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({matches:false}) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = cb => cb();
const { applyIPS } = await import('../src/ips-patcher.js');
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');
const { applyFeature } = await import('../src/dungeons/compile.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { Sprite, DIR_UP } = await import('../src/sprite.js');
const { SPRITE_PAL_TOP, SPRITE_PAL_BTM } = await import('../src/job-sprites.js');
const { initSpriteAssets } = await import('../src/boot.js');
const { initFont } = await import('../src/font-renderer.js');
const { drawBorderedBox } = await import('../src/hud-drawing.js');
const { showMsgBox, drawMsgBox, msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { encodeName } = await import('../src/data/strings.js');
const { ui } = await import('../src/ui-state.js');
const rom = fs.readFileSync(new URL('../FF3-English.nes',import.meta.url));
applyIPS(rom,fs.readFileSync(new URL('../patches/ff3-awj.ips',import.meta.url)));
initSpriteAssets(rom);initFont(rom);
const sprite=new Sprite(rom,SPRITE_PAL_TOP,SPRITE_PAL_BTM);sprite.setDirection(DIR_UP);
const dg=DUNGEONS.find(d=>d.id==='mines');
const folder='/tmp/ff3mmo-evaluation';fs.mkdirSync(folder,{recursive:true});
for(const [floor,opened,x,y,label,text] of [
  [0,false,23,9,'face','Search its northern wall.'],
  [0,true,23,9,'stair','An old stair lies beyond.'],
  [1,false,20,8,'cache','The hidden working!'],
]) {
  const md=generateFloor(rom,floor,1754900000000,dg);
  if(opened)applyFeature(md,md.features.find(f=>f.kind==='passage'),dg);
  const renderer=new MapRenderer(md,md.entranceX,md.entranceY);
  const canvas=createCanvas(256,240),ctx=canvas.getContext('2d');ui.ctx=ctx;
  const cameraX=x*16-120,cameraY=y*16-136;
  renderer.draw(ctx,cameraX,cameraY,0,0);sprite.draw(ctx,120,136);
  forceCloseMsgBox();showMsgBox(encodeName(text));msgState.state='hold';msgState.typed=msgState.bytes.length;
  drawMsgBox(ctx,drawBorderedBox);
  fs.writeFileSync(`${folder}/mines-${label}-game.png`,canvas.toBuffer('image/png'));
}
console.log('Mines game-camera review rendered to /tmp/ff3mmo-evaluation/mines-{face,stair,cache}-game.png');
