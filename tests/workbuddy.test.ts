import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayJobs } from "../src/workbuddy/jobs.js";
import { DedicatedCore } from "../src/workbuddy/core.js";
const tick = () => new Promise(r => setTimeout(r, 20));
test("dedicated receipts survive reconnect and deduplicate without changing input", async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"wb-test-")); let calls=0;
 try {
  const jobs=new RelayJobs(dir,async (i,e)=>{calls++;e({type:"text",text:i.text});});
  jobs.submit("one",{text:"阿伟确认退出。",voice:true}); await tick();
  assert.equal(jobs.submit("one",{text:"阿伟确认退出。",voice:true}).state,"done");
  assert.equal(calls,1); assert.throws(()=>jobs.submit("one",{text:"别的内容"}));
  const reload=new RelayJobs(dir,async()=>{throw Error("must not replay");});
  assert.equal(reload.poll("one").events[0].text,"阿伟确认退出。");
  assert.equal(reload.poll("one",1).events.length,0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("busy messages not queued to a drifting target; interrupted receipt stays unknown", async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"wb-test-"));let finish!:()=>void;
 try {
  const jobs=new RelayJobs(dir,()=>new Promise<void>(r=>{finish=r;}));
  jobs.submit("one",{text:"工作"});await tick();
  assert.throws(()=>jobs.submit("two",{text:"另一任务"}),/未提交/);
  const reload=new RelayJobs(dir,async()=>{});assert.equal(reload.poll("one").state,"unknown");
  finish();await tick();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("all plain text and voice stay inside Awei, selected business gets originals", async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"wb-test-"));
 const core=new DedicatedCore({storageDir:dir,attachmentRoots:[],agent:{command:"unused",args:[],cwd:dir},codexServer:{command:"unused"}});
 const seen:string[]=[];let selected=false;
 (core as any).assistant={handle:async(_u:string,t:string,r:any)=>{seen.push("awei:"+t);await r("ok");},close:async()=>{}};
 (core.router as any).selected=()=>selected;
 (core.router as any).assistantContext=()=>({current:undefined});
 (core.router as any).handleInput=async(_u:string,blocks:any)=>{seen.push("business:"+blocks[0].text);};
 try {
  await core.run({text:"找旅行会话",voice:true},()=>{});
  selected=true;await core.run({text:"继续写方案",voice:true},()=>{});
  await core.run({text:"阿伟，切到第二个"},()=>{});
  assert.deepEqual(seen,["awei:找旅行会话","business:继续写方案","awei:切到第二个"]);
  const out:any[]=[];await core.run({text:"",voice:true},e=>out.push(e));assert.match(out[0].text,/未提供转写/);
 }finally{await core.close();rmSync(dir,{recursive:true,force:true});}
});
