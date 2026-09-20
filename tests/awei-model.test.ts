import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpLanguageService } from "../src/awei/model.js";
function fixture(mode: "ok" | "unsupported" | "tool" | "hang" | "usage") {
  return `import readline from 'node:readline';
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const respond=result=>emit({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize'){
   if(m.params.clientCapabilities.fs.readTextFile || m.params.clientCapabilities.terminal) process.exit(2);
   respond({protocolVersion:1,agentCapabilities:{}});
 } else if(m.method==='session/new') respond({sessionId:'manager-test',modes:{currentModeId:'agent',availableModes:${mode === "unsupported" ? '[]' : '[{id:"read-only",name:"Read only"}]'}}});
 else if(m.method==='session/set_mode') respond({});
 else if(m.method==='session/prompt') {
   ${mode === "hang" ? 'return;' : ''}
   ${mode === "usage" ? "emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'manager-test',update:{sessionUpdate:'usage_update',used:80,size:100}}});" : ''}
   ${mode === "tool" ? "emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'manager-test',update:{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Forbidden terminal',kind:'execute',status:'pending'}}});" : ''}
   emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'manager-test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"action":"current"}'}}}});
   respond({stopReason:'end_turn'});
 }
});`;
}
for (const mode of ["ok", "unsupported", "tool", "hang"] as const) test(`ACP language transport ${mode}`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "awei-model-"));
  const ids: string[] = [];
  const model = new AcpLanguageService({ command: process.execPath, args: ["--input-type=module", "-e", fixture(mode)], cwd: dir }, id => ids.push(id), mode === "hang" ? 500 : 5000);
  try {
    if (mode === "ok") {
      assert.equal(await model.ask("test"), '{"action":"current"}');
      assert.equal(await model.ask("second request"), '{"action":"current"}');
      assert.equal(ids.length, 1);
    } else await assert.rejects(model.ask("test"), mode === "unsupported" ? /未提供/ : mode === "tool" ? /工具调用/ : /超时/);
    await model.close();
    assert.equal((model as any).child, undefined);
  } finally { await model.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const reason of ["usage", "calls", "characters"] as const) test(`ACP rotates at request boundary via ${reason}, not between research steps`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "awei-rotate-"));
  const ids: string[] = [];
  const model = new AcpLanguageService({ command: process.execPath, args: ["--input-type=module", "-e", fixture(reason === "usage" ? "usage" : "ok")], cwd: dir }, id => ids.push(id), 5000,
    reason === "calls" ? { maxCalls: 2 } : reason === "characters" ? { maxCharacters: 30 } : {});
  try {
    await model.beginRequest("first");
    await model.ask("research step one"); await model.ask("research step two");
    assert.equal(ids.length, 1);
    assert.equal(model.status().rotations, 0);
    if (reason === "usage") assert.deepEqual(model.status().usage, { used: 80, size: 100 });
    await model.beginRequest("next request");
    assert.equal(model.status().rotations, 1);
    assert.equal(model.status().usage, null);
    assert.equal(ids.length, 1, "new session is lazy; help/confirm needs no model");
    await model.ask("new task");
    assert.equal(ids.length, 2, "every new internal session goes through hide callback");
    assert.equal(model.status().calls, 1);
  } finally { await model.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ACP below threshold keeps session; usage reflects compaction and ignores foreign updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "awei-usage-"));
  const code = fixture("usage").replace("respond({stopReason:'end_turn'});", `
emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'manager-test',update:{sessionUpdate:'usage_update',used:10,size:100}}});
emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'other-session',update:{sessionUpdate:'usage_update',used:99,size:100}}});
respond({stopReason:'end_turn'});`);
  const ids: string[] = [];
  const model = new AcpLanguageService({ command: process.execPath, args: ["--input-type=module", "-e", code], cwd: dir }, id => ids.push(id));
  try {
    await model.ask("first"); await model.beginRequest("next"); await model.ask("second");
    assert.deepEqual(model.status().usage, { used: 10, size: 100 });
    assert.equal(ids.length, 1);
  } finally { await model.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ACP never rotates an in-flight prompt or retries it after timeout", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "awei-busy-"));
  const ids: string[] = [];
  const model = new AcpLanguageService({ command: process.execPath, args: ["--input-type=module", "-e", fixture("hang")], cwd: dir }, id => ids.push(id), 500, { maxCalls: 1 });
  try {
    const pending = assert.rejects(model.ask("only once"), /超时/);
    await assert.rejects(model.beginRequest("next"), /上一条/);
    await pending;
    assert.equal(ids.length, 1); assert.equal(model.status().rotations, 0);
  } finally { await model.close(); await rm(dir, { recursive: true, force: true }); }
});
