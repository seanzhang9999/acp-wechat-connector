import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probeAntigravity } from '../src/antigravity/probe.js';
const fixture=path.resolve('tests/fixtures/antigravity-agent.mjs');
const run=(scenario:string, modelId:string|undefined='test-opus')=>probeAntigravity({command:process.execPath,args:[fixture,scenario],cwd:process.cwd(),modelId,timeoutMs:2000});
test('discovery does not claim a model call',async()=>{
 const r=await probeAntigravity({command:process.execPath,args:[fixture,'ok'],cwd:process.cwd(),timeoutMs:2000});
 assert.equal(r.status,'discovered'); assert.equal(r.modelCallVerified,false); assert.deepEqual(r.availableModelIds,['test-opus']);
});
test('selects advertised grouped model and confirms response',async()=>{
 const r=await run('ok'); assert.equal(r.status,'passed'); assert.equal(r.modelId,'test-opus');
});
test('unknown model never falls back',async()=>{await assert.rejects(run('ok','missing'),/requested_model_not_advertised/)});
test('selection mismatch fails before prompt',async()=>{await assert.rejects(run('wrong-model'),/model_selection_unconfirmed/)});
test('mid-response model switch cannot pass',async()=>{await assert.rejects(run('switch'),/model_changed_during_prompt/)});
test('permission is refused and cannot produce a passing receipt',async()=>{await assert.rejects(run('permission'),/probe_requested_tools/)});
test('dead provider fails',async()=>{await assert.rejects(run('exit'),/acp_disconnected/)});
test('hung provider times out',async()=>{await assert.rejects(probeAntigravity({command:process.execPath,args:[fixture,'timeout'],cwd:process.cwd(),timeoutMs:150}),/probe_timeout/)});
test('missing executable fails without leaking diagnostics',async()=>{await assert.rejects(probeAntigravity({command:'/nonexistent/agy',cwd:process.cwd(),timeoutMs:500}),/cli_spawn_failed|acp_disconnected/)});
