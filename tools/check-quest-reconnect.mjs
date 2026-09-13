#!/usr/bin/env node
import assert from 'node:assert/strict';
import { claimsForProgress } from '../src/data/quest-recovery.js';
let now=10000, poll, socket;
Date.now=()=>now;
globalThis.localStorage={getItem:()=> 'test-token'};
globalThis.location={protocol:'http:',host:'localhost'};
globalThis.setInterval=fn=>{poll=fn;return 1;};
globalThis.clearInterval=()=>{};
class Socket {
  static OPEN=1; static CONNECTING=0;
  readyState=1; listeners=new Map(); sent=[];
  constructor(){socket=this;}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  send(data){this.sent.push(JSON.parse(data));}
  emit(type,data){this.listeners.get(type)?.(type==='message'?{data:JSON.stringify(data)}:data);}
}
globalThis.WebSocket=Socket;
const net=await import('../src/net.js');
let progress={argus_time_wheel:{s:'done'}};
const expected=claimsForProgress(progress);
assert.equal(expected.length,2,'Time Wheel stage and final reward must both recover');
net.setNetQuestRecoveryProvider(()=>claimsForProgress(progress));
const verdicts=[]; net.setNetQuestResultHandler(msg=>verdicts.push(msg));
const profile=()=>({slot:0,name:[65],allies:[]});
net.connectNet(profile,()=> 'canaan');
socket.emit('open');socket.emit('message',{type:'ready',userId:'test'});
const claims=()=>socket.sent.filter(m=>m.type==='quest-claim');
function tick(ms=1500){now+=ms;poll();}
assert.equal(claims().length,0);tick();
assert.equal(claims().length,1);
assert.equal(claims()[0].stageId,expected[0].stageId);
socket.emit('message',{type:'quest-result',txnId:claims()[0].txnId,status:'ok'});
assert.equal(verdicts.length,0,'recovered rewards must not execute local grant handlers');
tick();const final=claims().at(-1);
assert.equal(final.stageId,undefined);
socket.emit('message',{type:'quest-result',txnId:final.txnId,status:'rejected',reason:'inv-full'});
assert.equal(verdicts.at(-1).recovery,true);
assert.equal(verdicts.at(-1).claim.questId,'argus_time_wheel');
tick(9999);assert.equal(claims().length,2);
tick(1);assert.equal(claims().length,3);
socket.emit('message',{type:'quest-result',txnId:claims().at(-1).txnId,status:'rejected',reason:'already-claimed'});
assert.equal(verdicts.length,1,'already-paid reconnect must not grant twice');
// A new hello rebuilds any unacknowledged claim from durable story state.
net.connectNet(profile,()=> 'canaan');tick();assert.equal(claims().length,4);
// Switching to a new character must discard the previous character's queue.
progress={};net.connectNet(()=>({...profile(),slot:1}),()=> 'ur');
tick(10000);assert.equal(claims().length,4);
assert.deepEqual(progress,{},'recovery mutated story progress');
console.log('check-quest-reconnect: OK — paced stage/final claims, full-bag retry, duplicate acknowledgement, re-hello and slot switch');
