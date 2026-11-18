import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createServer} from 'node:net';
import {Store} from '../src/cloud/store.js';import {Approvals} from '../src/cloud/approvals.js';import {parseAction,DeepSeekLanguageService} from '../src/cloud/deepseek.js';import {AcpExecutor} from '../src/cloud/executor.js';import {CloudController} from '../src/cloud/controller.js';import {safeFile} from '../src/cloud/files.js';
const message={message_type:1,from_user_id:'owner',message_id:1,context_token:'context',item_list:[{type:1,text_item:{text:'/new say hello'}}]};
test('paired owner only; durable dedup and cursor transaction',()=>{const s=new Store(':memory:');s.ingest([message,{...message,message_id:2,from_user_id:'other'},{...message,message_id:3,group_id:'group'}],'cursor','owner');s.ingest([message],'next','owner');assert.equal(s.db.prepare('SELECT count(*) n FROM inbox').get()?.n,1);assert.equal(s.get('cursor'),'next');s.close();});
test('restart marks uncertain tasks and approvals, never reruns',()=>{const s=new Store(':memory:');s.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run('task','owner','original','opus','session','/tmp','running','');s.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?)').run('approval','task','owner',Date.now()+1000,'pending','x');s.recover();assert.equal(s.task('task','owner')?.status,'unknown');assert.equal(s.db.prepare('SELECT status FROM approvals').get()?.status,'expired');assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get()?.n,1);s.close();});
test('DeepSeek strictly validates permitted actions and ignores credentials in errors',async()=>{assert.throws(()=>parseAction('{"action":"new","command":"rm"}'));assert.throws(()=>parseAction('{"action":"approve"}'));const svc=new DeepSeekLanguageService('secret','test',async()=>new Response('secret diagnostic',{status:401}));await assert.rejects(svc.ask('hi'),/^Error: deepseek_http_401$/);});
test('approval is owner-bound, single-use, expiring and deny-only without allow_once',async()=>{const s=new Store(':memory:');s.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run('task','owner','x','opus',null,'/tmp','running','');const a=new Approvals(s,30);const p={sessionId:'session',toolCall:{toolCallId:'tool',title:'safe'},options:[{optionId:'yes',kind:'allow_once' as const,name:'Allow'}]};const pending=a.request('task','owner',p,new AbortController().signal);const id=(s.db.prepare('SELECT id FROM approvals').get() as any).id;assert.equal(a.resolve('intruder',id,true),false);assert.equal(a.resolve('owner',id,true),true);assert.equal(a.resolve('owner',id,true),false);assert.equal((await pending).outcome.outcome,'selected');assert.equal((await a.request('task','owner',p,new AbortController().signal)).outcome.outcome,'cancelled');s.close();});
test('attachment traversal and symlink escape are refused',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'awei-file-'));try{await mkdir(path.join(root,'task'));await writeFile(path.join(root,'outside'),'secret');await symlink(path.join(root,'outside'),path.join(root,'task','link'));await assert.rejects(safeFile(path.join(root,'task'),'../outside'));await assert.rejects(safeFile(path.join(root,'task'),'link'));}finally{await rm(root,{recursive:true,force:true});}});
test('actual task route records tokens and duplicate ingress never runs twice',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'awei-route-'));const s=new Store(':memory:');let calls=0;const fake={run:async(i:any)=>{calls++;await i.onSession('session');await i.onSubmitted();return {text:'original answer',stopReason:'end_turn',usage:{accountingScope:'fresh_session_single_prompt',tokens:{inputTokens:20,outputTokens:3,totalTokens:23}}};}};const c=new CloudController(s,fake as any,root,path.join(root,'usage'),'opus');try{s.ingest([message],'x','owner');await c.handle(s.next()!);await c.active?.promise;s.ingest([message],'y','owner');assert.equal(s.next(),undefined);assert.equal(calls,1);const t=s.list('owner')[0];assert.equal(t.status,'succeeded');assert.equal(t.result,'original answer');assert.match(String(s.db.prepare('SELECT usage FROM turns').get()?.usage),/23/);assert.ok(Number(s.db.prepare('SELECT count(*) n FROM outbox').get()?.n)>0);}finally{s.close();await rm(root,{recursive:true,force:true});}});
test('ACP negotiates manual mode, restores exact session, preserves usage',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'awei-acp-'));const socket=path.join(root,'agent.sock');let loaded='';let selected='';const options=[{id:'model',name:'Model',category:'model',type:'select',currentValue:'opus',options:[{value:'opus',name:'Opus'}]}];const server=createServer(s=>{let buf='';s.on('data',b=>{buf+=b;let n;while((n=buf.indexOf('\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);let result:any={};if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};if(m.method==='session/load'){loaded=m.params.sessionId;result={configOptions:options,modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}};}if(m.method==='session/set_config_option')result={configOptions:options};if(m.method==='session/set_mode')selected=m.params.modeId;if(m.method==='session/prompt'){s.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'kept-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}}}})+'\n');result={stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,totalTokens:12}};}if(m.id!==undefined)s.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');}});});await new Promise<void>(r=>server.listen(socket,r));try{const r=await new AcpExecutor(socket).run({cwd:root,session:'kept-session',model:'opus',prompt:'go',signal:new AbortController().signal,onSession:async()=>{},onSubmitted:async()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})});assert.equal(loaded,'kept-session');assert.equal(selected,'default');assert.equal(r.text,'answer');assert.equal(r.usage.tokens?.totalTokens,12);assert.equal(r.usage.accountingScope,'resumed_session_unverified');}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}});

import {requestIlink} from '../src/cloud/transport.js';
test('iLink send timeout and API errors never count as delivery success',async()=>{const token={token:'not-real',baseUrl:'https://ilinkai.weixin.qq.com',userId:'u',accountId:'a',savedAt:''};await assert.rejects(requestIlink(token,'sendmessage',{},20,async()=>{throw Error('timeout');}),/timeout/);await assert.rejects(requestIlink(token,'sendmessage',{},20,async()=>new Response(JSON.stringify({ret:-14}))),/ilink_auth_expired/);});
test('messages before pairing and unfinished partials do not execute',()=>{const s=new Store(':memory:');s.ingest([{...message,create_time_ms:5},{...message,message_id:2,create_time_ms:20,message_state:1},{...message,message_id:3,create_time_ms:20,message_state:2}],'c','owner',10);assert.equal(s.db.prepare('SELECT count(*) n FROM inbox').get()?.n,1);s.close();});

test('denied operation is a failed task but retains model token usage',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'awei-deny-'));const s=new Store(':memory:');const c=new CloudController(s,{run:async(i:any)=>{await i.onSession('s');await i.onSubmitted();return {text:'attempted',stopReason:'end_turn',permissionsDenied:1,usage:{tokens:{totalTokens:123}}};}} as any,root,path.join(root,'usage'),'opus');try{s.ingest([message],'c','owner');await c.handle(s.next()!);await c.active?.promise;assert.equal(s.list('owner')[0].status,'failed');assert.match(String(s.db.prepare('SELECT usage FROM turns').get()?.usage),/123/);}finally{s.close();await rm(root,{recursive:true,force:true});}});

test('DeepSeek corrects invalid extra fields once without relaxing action schema',async()=>{
 let calls=0;
 const svc=new DeepSeekLanguageService('secret','test',async()=>{
  calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:calls===1?' {"action":"new","task":null}':'{"action":"new"}'}}]}));
 });
 assert.deepEqual(parseAction(await svc.ask('new task')),{action:'new'});assert.equal(calls,2);
 let invalidCalls=0;
 const invalid=new DeepSeekLanguageService('secret','test',async()=>{invalidCalls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"action":"new","command":"unsafe"}'}}]}));});
 await assert.rejects(invalid.ask('new task'),/deepseek_invalid_action/);assert.equal(invalidCalls,2);
});

test('plain language permission replies are bound to a delivered, live request',async()=>{
 const store=new Store(':memory:');
 const controller=new CloudController(store,{} as AcpExecutor,'/tmp','/tmp','opus');
 const permission=controller.approvals.request('task','owner',{
  sessionId:'session',toolCall:{toolCallId:'tool',title:'read'},
  options:[{optionId:'yes',kind:'allow_once',name:'Allow'}],
 },new AbortController().signal);
 const {id}=store.db.prepare('SELECT id FROM approvals').get() as {id:string};
 const now=Date.now();
 assert.equal(controller.approvals.resolveReply('owner',true,now),false);
 store.set('approval_sent:'+id,String(now));
 assert.equal(controller.approvals.resolveReply('owner',true,now-1),false);
 assert.equal(controller.approvals.resolveReply('other',true,now),false);
 store.ingest([{...message,create_time_ms:now,item_list:[{type:1,text_item:{
  text:'对当前任务同意 并且你作为中间智能体要学会以后这样处理',
 }}]}],'cursor','owner');
 await controller.handle(store.next()!);
 assert.deepEqual(await permission,{outcome:{outcome:'selected',optionId:'yes'}});
 assert.equal(controller.approvals.resolveReply('owner',true,now),false);
 store.close();
});
