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
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["awei_message","awei_poll","awei_status"]);
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
