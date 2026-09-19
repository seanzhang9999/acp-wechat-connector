import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpLanguageService } from "../src/awei/model.js";
function fixture(mode: "ok" | "unsupported" | "tool" | "hang") {
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
