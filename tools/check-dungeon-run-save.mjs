#!/usr/bin/env node
// Importing api.js opens a database: always run it in a disposable directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff3-dungeon-save-'));
try {
  const api = new URL('../api.js', import.meta.url).href;
  const codec = new URL('../src/save.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module','-e', `
    import assert from 'node:assert/strict';
    import { _testValidateSaveData } from ${JSON.stringify(api)};
    import { parseSaveSlots } from ${JSON.stringify(codec)};
    const run = {dungeonId:'mines',version:1,seed:1754900087109,
      features:{'old-face':1,'sword-cache':1,'not-a-feature':1}};
    const result = _testValidateSaveData({name:[65],dungeonRun:run});
    assert.equal(result.ok,true);
    const saved = result.data;
    assert(saved);
    assert.deepEqual(saved.dungeonRun,{...run,features:{'old-face':1,'sword-cache':1}});
    assert.deepEqual(parseSaveSlots([saved])[0].dungeonRun,saved.dungeonRun);
    for (const value of [null,{},[],{...run,version:2},{...run,seed:-1},{...run,seed:Infinity}]) {
      assert.equal(_testValidateSaveData({name:[65],dungeonRun:value}).data.dungeonRun,null);
    }
    assert.equal(_testValidateSaveData({name:[65]}).data.dungeonRun,null);
    const owen={dungeonId:'owen',version:1,seed:1754900087109,features:{'power-bank':1,'control-power':1,'old-face':1}};
    const tower=_testValidateSaveData({name:[65],onWorldMap:true,worldX:63*16,worldY:32*16,dungeonRun:owen}).data;
    assert.deepEqual(tower.dungeonRun.features,{'power-bank':1,'control-power':1});
    assert.deepEqual(parseSaveSlots([tower])[0].dungeonRun,tower.dungeonRun);
    assert.equal(tower.onWorldMap,true);assert.equal(tower.worldX,63*16);assert.equal(tower.worldY,32*16);
    console.log('PASS: actual server save validation and client codec preserve versioned dungeon progress.');
  `], { cwd: dir, encoding: 'utf8', timeout: 30000, env: {...process.env, JWT_SECRET: 'dungeon-save-fixture-only'} });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status,0,result.error?.message || 'server save integration failed');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
