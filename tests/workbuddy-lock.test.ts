import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { RelayLock, lockStatus, ownerLiveness, parseOwner, processStart, requestRelease, type Owner } from "../src/workbuddy/lock.js";
import { RelayLifecycle } from "../src/workbuddy/lifecycle.js";
const dir = () => mkdtempSync(path.join(os.tmpdir(), "awei-lock-test-"));
const owner = (): Owner => ({v:1,pid:process.pid,startedAt:new Date(processStart(process.pid)!).toISOString(),host:"awei-dedicated-session",version:"0.15.0"});
async function start(folder: string, mode = "") {
 const p = spawn(process.execPath,["--import","tsx/esm","tests/fixtures/relay-lock-owner.mjs",folder,mode],{stdio:["ignore","pipe","pipe"]});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{p.kill("SIGKILL");reject(Error("fixture timeout"))},5000);p.stdout!.once("data",()=>{clearTimeout(timer);resolve()});p.once("exit",code=>{clearTimeout(timer);reject(Error("fixture exited "+code))});});return p;
}
async function stop(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") { if(p.exitCode!==null||p.signalCode!==null)return;const end=once(p,"exit");p.kill(signal);await end; }
test("owner metadata, legacy parsing and liveness fail closed for PID reuse and EPERM",()=>{
 assert.equal(parseOwner(""),null);assert.equal(parseOwner("bad"),null);assert.equal(parseOwner('{}'),null);
 const o=owner();assert.equal(parseOwner(JSON.stringify(o))?.pid,process.pid);assert.equal(ownerLiveness(o),"alive");
 assert.equal(ownerLiveness(o,{kill:()=>true,start:()=>Date.parse(o.startedAt)+3000}),"unknown");
 assert.equal(ownerLiveness(o,{kill:()=>true,start:()=>null}),"unknown");
 assert.equal(ownerLiveness(o,{kill:()=>{throw Object.assign(Error(),{code:"EPERM"})},start:()=>null}),"alive-foreign");
 assert.equal(ownerLiveness(o,{kill:()=>{throw Object.assign(Error(),{code:"ESRCH"})},start:()=>null}),"dead");
});
test("read-only missing status does not create storage",()=>{
 const d=dir(),missing=path.join(d,"missing");try{assert.deepEqual(lockStatus(missing),{lock:null,liveness:null});assert.equal(existsSync(missing),false);}finally{rmSync(d,{recursive:true,force:true});}
});
test("SIGKILL owner is reclaimed on ordinary startup and old lock is archived",async()=>{
 const d=dir();let p:ChildProcess|undefined;const lock=new RelayLock(d);
 try{p=await start(d);const old=readFileSync(path.join(d,"relay.lock"),"utf8");await stop(p,"SIGKILL");await lock.acquire();assert.equal(lockStatus(d).lock?.holderPid,process.pid);const archived=readdirSync(d).find(n=>n.startsWith("relay.lock.reclaimed-"))!;assert.equal(readFileSync(path.join(d,archived),"utf8"),old);assert.match(readFileSync(path.join(d,"diagnostics.log"),"utf8"),/lock:reclaimed-stale/);lock.release("test");}
 finally{if(p)await stop(p,"SIGKILL");await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("live owner rejects ordinary startup and takeover without force",async()=>{
 const d=dir();const p=await start(d),lock=new RelayLock(d);
 try{await assert.rejects(lock.acquire(),new RegExp(`PID ${p.pid}.*--take-over`));await assert.rejects(lock.acquire({takeOver:true}),e=>(e as any).exitCode===2);assert.equal(lockStatus(d).lock?.holderPid,p.pid);}
 finally{await stop(p);await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("explicit force terminates owner, archives evidence and audits takeover",async()=>{
 const d=dir();const p=await start(d,"ignore-term"),lock=new RelayLock(d);
 try{await lock.acquire({takeOver:true,force:true});assert.equal(lockStatus(d).lock?.holderPid,process.pid);const log=readFileSync(path.join(d,"diagnostics.log"),"utf8");assert.match(log,/"action":"sigterm"/);assert.match(log,/"action":"sigkill"/);assert.ok(readdirSync(d).some(n=>n.startsWith("relay.lock.reclaimed-")));lock.release("test");}
 finally{await stop(p,"SIGKILL");await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("legacy lock requires explicit takeover and never ignores observed legacy activity",async()=>{
 const d=dir(),lock=new RelayLock(d);writeFileSync(path.join(d,"relay.lock"),"");
 try{assert.equal(lockStatus(d).liveness,"legacy-unknown");await assert.rejects(lock.acquire(),/--take-over/);await assert.rejects(lock.acquire({takeOver:true,legacyActive:()=>true}));await lock.acquire({takeOver:true,legacyActive:()=>false});lock.release("test");}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("release refuses active jobs; successful release gates admission and writes handover",async()=>{
 const d=dir(),lock=new RelayLock(d);await lock.acquire();let running=true,closed=0;
 const life=new RelayLifecycle(lock,{hasRunning:()=>running},{close:async()=>{closed++;}},180);
 try{assert.deepEqual((await life.release()).released,false);assert.ok(lock.owns());assert.equal(closed,0);running=false;assert.deepEqual(await life.release("switch"),{released:true});assert.equal(closed,1);assert.equal(life.accepting(),false);assert.equal(existsSync(path.join(d,"relay.lock")),false);assert.equal(JSON.parse(readFileSync(path.join(d,"relay.handover.json"),"utf8")).graceSeconds,180);}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("grace blocks restarts, explicit takeover overrides and expiry permits normal start",async()=>{
 const d=dir(),lock=new RelayLock(d);await lock.acquire();lock.release("switch",180);await lock.closeGate();
 try{await assert.rejects(lock.acquire(),/--take-over/);await lock.acquire({takeOver:true});lock.release("test",0);await lock.closeGate();await lock.acquire();lock.release("test");}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("claim is standby under a live owner without touching the lock, and owns when free",async()=>{
 const d=dir(),lock=new RelayLock(d);
 try{
  const holder=new RelayLock(d);await holder.acquire();
  const standby=await lock.claim();
  assert.equal(standby.kind,"standby");
  if(standby.kind==="standby"){assert.equal(standby.holder?.pid,process.pid);assert.equal(standby.holder?.alive,true);}
  assert.equal(lockStatus(d).lock?.holderPid,process.pid); // untouched by the standby claim
  await holder.closeGate();holder.release("test");
  const own=await lock.claim({bypassGrace:true});
  assert.equal(own.kind,"owner");
  lock.release("test");
 } finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("CLI control request asks real owner to release; no owner never deletes files",async()=>{
 const d=dir(),lock=new RelayLock(d);await lock.acquire();const life=new RelayLifecycle(lock,{hasRunning:()=>false},{close:async()=>{}},0);
 lock.onRelease(r=>life.release(r),()=>{});
 try{assert.deepEqual(await requestRelease(d),{released:true});assert.equal(existsSync(path.join(d,"relay.lock")),false);assert.equal((await requestRelease(d)).released,false);}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("concurrent recovery attempts produce only one owner",async()=>{
 const d=dir(),p=await start(d);await stop(p,"SIGKILL");const a=new RelayLock(d),b=new RelayLock(d);
 try{const results=await Promise.allSettled([a.acquire(),b.acquire()]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);if(a.owns())a.release("test");else b.release("test");}
 finally{await a.closeGate();await b.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("PID reuse is never force-killed and expired grace permits start",async()=>{
 const d=dir(),lock=new RelayLock(d);writeFileSync(path.join(d,"relay.lock"),JSON.stringify({...owner(),startedAt:new Date(Date.now()-86400000).toISOString()}));
 try{await assert.rejects(lock.acquire({takeOver:true,force:true}),/身份或权限无法核实/);assert.ok(existsSync(path.join(d,"relay.lock")));rmSync(path.join(d,"relay.lock"));writeFileSync(path.join(d,"relay.handover.json"),JSON.stringify({releasedAt:new Date(Date.now()-181000).toISOString(),graceSeconds:180}));await lock.acquire();lock.release("test");}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
test("failed idle checks preserve ownership; admission closes while successful cleanup is pending",async()=>{
 const d=dir(),lock=new RelayLock(d);await lock.acquire();let idle=false,finish!:()=>void;
 const life=new RelayLifecycle(lock,{hasRunning:()=>false},{assertReleasable:async()=>{if(!idle)throw Error("approval pending")},close:()=>new Promise<void>(r=>{finish=r})},0);
 try{assert.equal((await life.release()).released,false);assert.ok(lock.owns());idle=true;const result=life.release();assert.equal(life.accepting(),false);await new Promise(r=>setTimeout(r,0));finish();assert.equal((await result).released,true);}
 finally{await lock.closeGate();rmSync(d,{recursive:true,force:true});}
});
