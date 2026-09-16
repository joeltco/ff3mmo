#!/usr/bin/env node
// Revert proof for authored tower rules: each .bak restores a deliberately
// regressed planner, not an invented claim that the old cave planner had these
// features. Always restore the working bytes in finally; never invoke Git.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const root=new URL('../',import.meta.url).pathname;
const source=path.join(root,'src/dungeons/definitions/owen.js');
const out='/tmp/ff3mmo-owen-prototype';fs.mkdirSync(out,{recursive:true});
const fixed=fs.readFileSync(source);fs.writeFileSync(path.join(out,'owen-fixed.bak'),fixed);
const cases=[
  ['A','const shell = [1, 3, 14, 12];','const shell = [1, 3, 15, 12];','A: structural envelope must be 14x10'],
  ['C','exit = floor === 4 ? [1, 8] : [1, 10];','exit = floor === 4 ? [1, 8] : [12, 4];','C: arrival and onward stair must oppose'],
  ['D','rect(12, 3, 14, 5);','rect(12, 3, 14, 5); rect(2, 4, 11, 11);','D: shaft density'],
  ['E',"kind: 'chest', at: [14, 12]","kind: 'chest', at: [2, 6]",'E: gallery-cache detour'],
];
for(const [gate,good,bad,expected]of cases){
  assert(fixed.toString().includes(good),`missing mutation anchor ${gate}`);
  const backup=path.join(out,`owen-regressed-${gate}.bak`);
  fs.writeFileSync(backup,fixed.toString().replace(good,bad));
  try{
    fs.copyFileSync(backup,source);
    const result=spawnSync(process.execPath,['tools/check-owen-prototype.mjs',`--gate=${gate}`,'--seeds=1'],{cwd:root,encoding:'utf8',timeout:30000});
    const output=(result.stdout||'')+(result.stderr||'');
    fs.writeFileSync(path.join(out,`revert-${gate}.log`),output);
    assert(result.status!==0&&output.includes(expected),`Gate ${gate} did not fail for the intended reason:\n${output}`);
    console.log(`${gate}: ${output.split('\n').find(line=>line.includes('AssertionError'))}`);
  }finally{fs.copyFileSync(path.join(out,'owen-fixed.bak'),source);}
  assert.deepEqual(fs.readFileSync(source),fixed);
}
console.log('PASS: A/C/D/E each failed on its .bak regression; planner restored byte-for-byte.');
// The shared boundary must both reject corruption and be wired into the legacy
// path. These independent regressions prevent a green but disconnected helper.
for(const [name,file,good,bad,expected]of [
  ['contract-checks','src/dungeons/validate.js','export function validateDungeonFloor(map, dungeon) {','export function validateDungeonFloor(map, dungeon) { return;','Missing expected exception'],
  ['contract-wiring','src/dungeon-generator.js','try { validateDungeonFloor(result, dungeon); return result; }','try { return result; }','boundary not called for altar'],
]){
  const target=path.join(root,file),saved=fs.readFileSync(target),goodBackup=path.join(out,`${name}-fixed.bak`),badBackup=path.join(out,`${name}-regressed.bak`);
  assert(saved.toString().includes(good));fs.writeFileSync(goodBackup,saved);fs.writeFileSync(badBackup,saved.toString().replace(good,bad));
  try{
    fs.copyFileSync(badBackup,target);
    const result=spawnSync(process.execPath,['tools/check-dungeon-contract.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
    const output=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(path.join(out,`revert-${name}.log`),output);
    assert(result.status!==0&&output.includes(expected),`${name} did not fail correctly: ${output}`);
    console.log(`${name}: ${output.split('\n').find(line=>line.includes('AssertionError'))}`);
  }finally{fs.copyFileSync(goodBackup,target);}
  assert.deepEqual(fs.readFileSync(target),saved);
}
