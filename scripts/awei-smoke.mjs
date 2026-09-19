// Explicit opt-in real ACP/model test. All business sessions and actions are fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpLanguageService } from '../dist/src/awei/model.js';
import { AweiController } from '../dist/src/awei/controller.js';
import { CodexRouter } from '../dist/src/codex/router.js';
if (!process.argv[2]) throw new Error('Usage: node scripts/awei-smoke.mjs /path/to/config.local.json (uses model quota)');
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'awei-smoke-'));
const calls = [];
const rpc = {
  async request(method, params) {
    calls.push({method, params});
    if (method === 'thread/list') return {data:[{id:'egypt',name:'埃及旅行行程'},{id:'work',name:'工作项目'}]};
    if (method === 'thread/turns/list') return {data:[{id:'test-turn',items:[{type:'userMessage',content:[{type:'text',text:'埃及行程安排五天'}]},{type:'agentMessage',text:'第一天到开罗。'}]}],nextCursor:null};
    throw new Error('Unexpected business operation: '+method);
  },
  onEvent() { return () => {}; }, async close() {},
};
const router = new CodexRouter(rpc, cwd);
const model = new AcpLanguageService({...config.agent,cwd}, id=>router.hideAssistantSession(id));
const actions = {async release(){throw new Error('No real release allowed');},async quit(){throw new Error('No real desktop quit allowed');},async off(){return 'off';}};
const ctl = new AweiController(model,router,actions);
const output=[];
const reply=async text=>{output.push(text);console.log(text);};
try {
  await ctl.handle('smoke','找一下埃及旅行会话',reply);
  assert.ok(calls.some(c=>c.method==='thread/list'));
  assert.equal(router.selected('smoke'),false);
  await ctl.handle('smoke','切到第一个',reply);
  assert.equal(router.assistantContext('smoke').current?.id,'egypt');
  await ctl.handle('smoke','看看最近五轮对话',reply);
  assert.equal(calls.at(-1).method,'thread/turns/list');
  assert.equal(calls.at(-1).params.limit,5);
  assert.match(output.at(-1),/开罗/);
  console.log('AWEI_SMOKE_OK: real ACP interpretation; fake business sessions only');
} finally {await ctl.close();await router.close();}
