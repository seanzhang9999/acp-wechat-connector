import {test} from 'node:test';
import assert from 'node:assert/strict';
import {userError,OperationFailure} from '../src/errors.js';
import {CodexRouter} from '../src/codex/router.js';
import type {Rpc} from '../src/codex/client.js';
test('nested errors classify cause but execution status is determined by dispatch phase',()=>{
 const log:string[]=[];
 const error=new Error('Internal error',{cause:{code:-32603,data:{details:'thread X already has an active writer'}}});
 const text=userError(new OperationFailure('not_sent',error),'unknown','发送',s=>log.push(s));
 assert.match(text,/SESSION_BUSY-/);assert.match(text,/未送入 agent 执行/);assert.match(text,/\/acp codex quit/);
 assert.ok(log[0].includes(text.match(/错误编号：(.*)/)![1]));
 const unknown=userError(new Error('timeout'),'unknown','发送',()=>{});
 assert.match(unknown,/无法确认/);assert.doesNotMatch(unknown,/可重新发送原消息/);
});
test('recognizes auth, permissions, quota, network, unsupported and hides unknown raw details',()=>{
 for(const [message,code] of [['401 unauthorized','AUTH'],['403 forbidden','PERMISSION'],['429 rate limit','LIMIT'],['ECONNRESET','CONNECTION'],['Method not found -32601','UNSUPPORTED']])assert.match(userError(new Error(message),'not_sent','请求',()=>{}),new RegExp(code+'-'));
 const logs:string[]=[];
 const text=userError(new Error('private content token=abcdef password=hunter2 Bearer secret-value https://host/?token=value'),'unknown','请求',s=>logs.push(s));
 assert.doesNotMatch(text,/private content|abcdef|hunter2/);assert.doesNotMatch(logs[0],/abcdef|hunter2|secret-value|token=value/);
 assert.match(userError(new Error('network error'),'completed','交付',()=>{}),/已完成本轮/);
});
test('router distinguishes resume failure from an uncertain turn start and never resends',async()=>{
 for(const stage of ['thread/resume','turn/start']){
  const calls:string[]=[];const out:string[]=[];
  const rpc:Rpc={async request<T>(m:string){calls.push(m);if(m===stage)throw Error('connection closed');return {thread:{id:'A',status:{type:'idle'}}} as T;},onEvent(){return ()=>{};},async close(){}};
  const r=new CodexRouter(rpc,'/work');await r.handle('u','/acp send 11111111-1111-1111-1111-111111111111 hello',async t=>{out.push(t);});
  assert.match(out.at(-1)!,stage==='thread/resume'?/未送入 agent 执行/:/执行状态无法确认/);
  assert.equal(calls.filter(x=>x==='turn/start').length,stage==='turn/start'?1:0);await r.close();
 }
});
test('completed task delivery failure reports completed status without starting another turn',async()=>{
 let listener:(m:string,p:any)=>void=()=>{};let starts=0;const out:string[]=[];
 const rpc:Rpc={async request<T>(m:string){if(m==='turn/start'){starts++;return {turn:{id:'T'}} as T;}return {thread:{id:'A',status:{type:'idle'}}} as T;},onEvent(h){listener=h;return ()=>{};},async close(){}};
 const r=new CodexRouter(rpc,'/work');
 const reply=async(t:string)=>{if(t.includes('final-content'))throw Error('network unavailable');out.push(t);};
 await r.handle('u','/acp send 11111111-1111-1111-1111-111111111111 hello',reply);
 listener('turn/completed',{threadId:'A',turn:{id:'T',status:'completed',items:[{type:'agentMessage',text:'final-content'}]}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(out.at(-1)!,/Agent 已完成本轮/);assert.match(out.at(-1)!,/避免重发导致重复执行/);assert.equal(starts,1);await r.close();
});
