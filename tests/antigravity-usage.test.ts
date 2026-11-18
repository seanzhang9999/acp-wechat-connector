import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, summarizeUsage } from '../src/antigravity/usage-ledger.js';
import { sanitizeTokens } from '../src/antigravity/probe.js';
test('usage rejects invalid and sensitive fields without guessing absent tokens',()=>{
 assert.equal(sanitizeTokens({inputTokens:-1,outputTokens:NaN,token:'secret'}),null);
 assert.deepEqual(sanitizeTokens({inputTokens:12,outputTokens:3,token:'secret'}),{inputTokens:12,outputTokens:3});
});
test('ledger counts once, preserves unknown crash state, does not add context or repeat session totals',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-meter-'));
 try {
 const a=new UsageLedger(dir,'opus'); await a.write(); await a.write({status:'prompt_started',promptStarted:true});
 await a.write({status:'passed',usage:{accountingScope:'fresh_session_single_prompt',tokens:{inputTokens:12,outputTokens:3},context:{used:999,size:200000}}});
 const b=new UsageLedger(dir,'opus');await b.write({status:'prompt_started',promptStarted:true});
 const c=new UsageLedger(dir,'opus');await c.write({status:'passed',promptStarted:true,usage:{accountingScope:'resumed_session',tokens:{inputTokens:999}}});
 const r=await summarizeUsage(dir); assert.equal(r.groups.opus.invocations,3);assert.equal(r.groups.opus.submittedPrompts,3);assert.equal(r.groups.opus.unknown,1);
 assert.deepEqual(r.groups.opus.reportedTokens,{inputTokens:12,outputTokens:3});assert.equal(r.subscriptionRemaining,null);
 const raw=JSON.parse(await readFile(path.join(dir,`${a.id}.json`),'utf8'));assert.equal(raw.status,'passed');
 } finally {await rm(dir,{recursive:true,force:true});}
});
