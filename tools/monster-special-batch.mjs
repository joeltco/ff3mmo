import { spawn } from 'node:child_process';
import fs from 'node:fs';
// RESUMABLE. The long-running driver kept being restarted and losing everything,
// so state lives on disk: each monster's result is appended as it finishes and
// each invocation only picks up ids that are not already done. Re-running simply
// continues.
const RES='/tmp/mon-results.json';
const KNOWN=new Set(JSON.parse(fs.readFileSync('/tmp/known-sfx.json','utf8')));
const MONS=JSON.parse(fs.readFileSync('/tmp/spec-monsters.json','utf8'));
let done={};
try { done=JSON.parse(fs.readFileSync(RES,'utf8')); } catch {}
for(const v of Object.values(done)) for(const x of (v.vals||[])) KNOWN.add(x);
const todo=MONS.filter(m=>!(m in done)).slice(0, parseInt(process.env.BATCH||'20',10));
if(!todo.length){ console.log(`ALL DONE: ${Object.keys(done).length}/${MONS.length}`); process.exit(0); }
let i=0;
function one(){
  if(i>=todo.length) return Promise.resolve();
  const id=todo[i++];
  return new Promise(res=>{
    const c=spawn('node',['/tmp/monsfx.cjs'],{env:{...process.env,MON:id,ROUNDS:'10'},stdio:['ignore','pipe','ignore']});
    let o=''; c.stdout.on('data',d=>o+=d);
    const k=setTimeout(()=>c.kill('SIGKILL'),200000);
    c.on('exit',()=>{ clearTimeout(k);
      const line=o.trim().split('\n').filter(l=>/^mon /.test(l)).pop();
      const vals=line?[...new Set([...line.matchAll(/\$([0-9a-f]{1,2})=/g)].map(m=>parseInt(m[1],16)))]:[];
      done[id]={ok:!!line, vals};
      const fresh=vals.filter(v=>!KNOWN.has(v));
      fresh.forEach(v=>KNOWN.add(v));
      if(fresh.length) console.log(`${id}  NEW ${fresh.map(v=>'$'+v.toString(16)+'=nsf'+((v-0x3f)&0xff)).join(',')}   ${line}`);
      // MERGE on write. Each invocation used to persist its own in-memory copy,
      // so two batches running at once clobbered each other's results and the
      // swept count went DOWN (97 -> 93). Re-read and merge instead, which makes
      // concurrent invocations additive rather than destructive.
      let cur={}; try { cur=JSON.parse(fs.readFileSync(RES,'utf8')); } catch {}
      Object.assign(cur, done);
      Object.assign(done, cur);
      fs.writeFileSync(RES, JSON.stringify(cur));
      res(one()); });
  });
}
await Promise.all(Array.from({length:parseInt(process.env.POOL||'6',10)},one));
const n=Object.keys(done).length, bad=Object.values(done).filter(d=>!d.ok).length;
console.log(`batch complete — ${n}/${MONS.length} monsters swept, ${bad} produced no data`);
