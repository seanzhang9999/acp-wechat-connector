import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["awei_message","awei_poll","awei_release","awei_status"]);
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
 try {
  await client.connect(transport);
  const state:any=await client.callTool({name:"awei_status",arguments:{}});
  assert.equal(JSON.parse(state.content[0].text).lock.alive,true);
  const r:any=await client.callTool({name:"awei_release",arguments:{reason:"test handover"}});
  assert.equal(JSON.parse(r.content[0].text).released,true);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(existsSync(path.join(dir,"relay.lock")),false);assert.ok(existsSync(path.join(dir,"relay.handover.json")));
  const {spawnSync}=await import("node:child_process");
  const denied=spawnSync(process.execPath,["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg],{encoding:"utf8",timeout:5000});
  assert.equal(denied.status,2);assert.match(denied.stderr,/--take-over/);
  const next=new Client({name:"takeover-test",version:"1"});const child=new StdioClientTransport({command:process.execPath,args:["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg,"--take-over"],stderr:"pipe"});
  try{
   await next.connect(child);
   const attempt=spawnSync(process.execPath,["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg,"--take-over"],{encoding:"utf8",timeout:5000});assert.equal(attempt.status,2);assert.match(attempt.stderr,/PID/);
   const release=spawnSync(process.execPath,["--import","tsx/esm",path.resolve("bin/awei-workbuddy.ts"),cfg,"--release"],{encoding:"utf8",timeout:15000});assert.equal(release.status,0,release.stderr);assert.equal(JSON.parse(release.stdout).released,true);
  }finally{await next.close();}
 } finally {await client.close();await new Promise(r=>setTimeout(r,150));rmSync(dir,{recursive:true,force:true});}
});
