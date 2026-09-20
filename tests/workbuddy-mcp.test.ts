import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real stdio connector accepts dedicated help, returns image, and never launches Codex", async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"wb-mcp-"));
 const cfg=path.join(dir,"config.json");writeFileSync(cfg,JSON.stringify({storageDir:dir,attachmentRoots:[],agent:{command:"must-not-launch",args:[],cwd:dir},codexServer:{command:path.join(dir,"must-not-launch")}}));
 const client=new Client({name:"relay-test",version:"1"});
 const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg],stderr:"pipe"});
 try {
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["awei_acquire","awei_message","awei_poll","awei_release","awei_status","awei_transfer"]);
  const parse=(r:any)=>JSON.parse(r.content[0].text);
  let out=parse(await client.callTool({name:"awei_message",arguments:{receiptId:"hello",text:"阿维，你能做什么"}}));
  for(let i=0;i<50&&out.state==="running";i++){await new Promise(r=>setTimeout(r,20));out=parse(await client.callTool({name:"awei_poll",arguments:{receiptId:"hello"}}));}
  assert.equal(out.state,"done");assert.match(out.events[0].text,/我是阿维/);
  assert.ok(out.events.some((e:any)=>e.type==="image"&&existsSync(e.path)));
  const native = await client.callTool({name:"awei_poll",arguments:{receiptId:"hello"}});
  assert.ok((native.content as any[]).some(c=>c.type==="image"&&c.mimeType==="image/jpeg"&&Buffer.from(c.data,"base64").subarray(0,3).toString("hex")==="ffd8ff"));
  await client.callTool({name:"awei_message",arguments:{receiptId:"ack",text:"收到啦"}});
  let ack:any;
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,20));ack=parse(await client.callTool({name:"awei_poll",arguments:{receiptId:"ack"}}));if(ack.state==="done")break;}
  assert.match(ack.events[0].text,/有需要随时/);
  assert.equal(ack.events.length,1);
  const same=parse(await client.callTool({name:"awei_message",arguments:{receiptId:"hello",text:"阿维，你能做什么"}}));assert.equal(same.state,"done");
 }finally{await client.close();await new Promise(r=>setTimeout(r,100));rmSync(dir,{recursive:true,force:true});}
});
test("MCP release writes response before exiting and CLI release uses live control endpoint", async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),"wb-release-"));
 const cfg=path.join(dir,"config.json");writeFileSync(cfg,JSON.stringify({storageDir:dir,attachmentRoots:[],handoverGraceSeconds:180,agent:{command:"must-not-launch",args:[],cwd:dir},codexServer:{command:path.join(dir,"must-not-launch")}}));
 const client=new Client({name:"release-test",version:"1"});
 const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg],stderr:"pipe"});
 const parse=(r:any)=>JSON.parse(r.content[0].text);
 const callError=async(c:any,name:string,args:any)=>{try{const r=await c.callTool({name,arguments:args});return (r.content as any[]).map(x=>x.text).join("\n");}catch(e:any){return String(e?.message??e);}};
 try {
  await client.connect(transport);
  const state:any=await client.callTool({name:"awei_status",arguments:{}});
  assert.equal(JSON.parse(state.content[0].text).lock.alive,true);
  assert.equal(JSON.parse(state.content[0].text).mode,"owner");
  const oldHolderPid=JSON.parse(state.content[0].text).lock.holderPid;
  // A second plain startup must come up as a standby server with every tool visible, never exiting on contention.
  const second=new Client({name:"standby-test",version:"1"});
  const secondTransport=new StdioClientTransport({command:process.execPath,args:["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg],stderr:"pipe"});
  try{
   await second.connect(secondTransport);
   assert.deepEqual((await second.listTools()).tools.map(t=>t.name).sort(),["awei_acquire","awei_message","awei_poll","awei_release","awei_status","awei_transfer"]);
   const standby=parse(await second.callTool({name:"awei_status",arguments:{}}));
   assert.equal(standby.mode,"standby");
   assert.match(await callError(second,"awei_message",{receiptId:"x",text:"hi"}),/写权限/);
   assert.match(await callError(second,"awei_acquire",{}),/转移码/);
   assert.match(await callError(second,"awei_acquire",{code:"WRONG1"}),/转移码/);
   const ticket=parse(await client.callTool({name:"awei_transfer",arguments:{}}));
   assert.match(ticket.code,/^[ACDEFGHJKLMNPQRSTUVWXYZ2345679]{6}$/);
   const acquired=parse(await second.callTool({name:"awei_acquire",arguments:{code:ticket.code}}));
   assert.equal(acquired.acquired,true);
   await new Promise(r=>setTimeout(r,200));
   // The lease moved: the lock now belongs to the acquiring session, not the old holder.
   const newLock=JSON.parse(readFileSync(path.join(dir,"relay.lock"),"utf8"));
   assert.notEqual(newLock.pid,oldHolderPid);
   assert.equal(newLock.host,"awei-dedicated-session");
   await client.close(); // holder process exits after transfer
   const nowOwner=parse(await second.callTool({name:"awei_status",arguments:{}}));
   assert.equal(nowOwner.mode,"owner");
   const {spawnSync}=await import("node:child_process");
   const attempt=spawnSync(process.execPath,["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg,"--take-over"],{encoding:"utf8",timeout:5000});assert.equal(attempt.status,2,`stdout=${attempt.stdout} stderr=${attempt.stderr}`);assert.match(attempt.stderr,/PID/);
   const release=spawnSync(process.execPath,["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg,"--release"],{encoding:"utf8",timeout:15000});assert.equal(release.status,0,release.stderr);assert.equal(JSON.parse(release.stdout).released,true);
   await second.close().catch(()=>{});
   await new Promise(r=>setTimeout(r,150));
   assert.equal(existsSync(path.join(dir,"relay.lock")),false);assert.ok(existsSync(path.join(dir,"relay.handover.json")));
   // After a deliberate release the next plain startup reclaims the lease (grace no longer blocks the MCP path).
   const third=new Client({name:"reclaim-test",version:"1"});
   const thirdTransport=new StdioClientTransport({command:process.execPath,args:["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg],stderr:"pipe"});
   try{await third.connect(thirdTransport);
    const reclaimed=parse(await third.callTool({name:"awei_status",arguments:{}}));
    assert.equal(reclaimed.mode,"owner");
   }finally{await third.close();}
  }finally{await second.close().catch(()=>{});}
 } finally {await client.close().catch(()=>{});await new Promise(r=>setTimeout(r,150));rmSync(dir,{recursive:true,force:true});}
});
