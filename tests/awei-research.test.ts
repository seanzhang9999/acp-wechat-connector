import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AweiController } from '../src/awei/controller.js';
import { ResearchSession } from '../src/awei/research.js';
import { CodexRouter } from '../src/codex/router.js';
import type { Rpc } from '../src/codex/client.js';
class SearchBackend implements Rpc {
  calls: {method:string;params:any}[]=[];
  async request<T>(method:string,params:any):Promise<T> {
    this.calls.push({method,params});
    if(method==='thread/search') return {data:[{thread:{id:'A',name:'国庆安排'},snippet:'埃及酒店初步方案'},{thread:{id:'B',name:'后续确认'},snippet:'最终酒店决定'}]} as T;
    if(method==='thread/searchOccurrences') return {data:[{turnId:'T1',snippet:'埃及',turnCursor:'anchor-cursor'}]} as T;
    if(method==='thread/turns/list') return {data:[{id:params.threadId==='A'?'T1':'T2',items:[{type:'userMessage',content:[{type:'text',text:params.threadId==='A'?'早期计划甲酒店':'最终决定乙酒店'}]},{type:'reasoning',text:'SECRET'},{type:'agentMessage',phase:'commentary',text:'SECRET'}]}],nextCursor:params.cursor?null:'older'} as T;
    throw new Error('Forbidden method '+method);
  }
  onEvent(){return ()=>{};} async close(){}
}
test('searches body with unrelated titles, reads two sources and answers without resuming or switching',async()=>{
  const rpc=new SearchBackend(),router=new CodexRouter(rpc,'/work');
  const plans=[{action:'content_search',query:'埃及'},{action:'locate',ref:'A',query:'埃及'},{action:'read',ref:'A',anchor:'M1'},{action:'read',ref:'B'},{action:'answer',text:'初步方案是甲[E1]，后续决定乙[E2]。',sources:['E1','E2']}];
  const prompts:string[]=[],out:string[]=[];
  const c=new AweiController({async ask(p){prompts.push(p);return JSON.stringify(plans.shift());},async close(){}},router,{async release(){throw Error('unexpected');},async quit(){throw Error('unexpected');},async off(){throw Error('unexpected');}});
  await c.handle('u','之前埃及酒店最后怎么决定的？',async t=>{out.push(t);});
  assert.match(out.at(-1)!,/后续决定乙/);assert.match(out.at(-1)!,/国庆安排/);assert.match(out.at(-1)!,/轮次 T2/);
  assert.match(prompts.at(-1)!,/早期计划甲/);assert.match(prompts.at(-1)!,/最终决定乙/);assert.doesNotMatch(prompts.at(-1)!,/SECRET/);
  assert.equal(router.selected('u'),false);assert.equal(rpc.calls[2].params.cursor,'anchor-cursor');
  assert.ok(rpc.calls.every(c=>['thread/search','thread/searchOccurrences','thread/turns/list'].includes(c.method)));
  await router.close();
});
test('requires real read evidence; rejects invented IDs, wrong anchors and cross-request evidence',async()=>{
  const router=new CodexRouter(new SearchBackend(),'/work'),r=new ResearchSession(router,'u');
  await r.search('埃及',false);
  assert.throws(()=>r.answer('标题推测',['E1']),/实际读取/);
  await assert.rejects(r.read('invented',undefined,false,3),/真实会话/);
  await r.locate('A','埃及',false);
  await assert.rejects(r.read('B','M1',false,3),/不属于/);
  await r.read('A','M1',false,3);
  assert.throws(()=>r.answer('虚构来源[E2]',['E1']),/不一致/);
  assert.throws(()=>new ResearchSession(router,'u').answer('旧记忆',['E1']),/实际读取/);
  await r.read('A',undefined,false,3);
  await r.read('A',undefined,true,3);
  await assert.rejects(r.read('A',undefined,true,3),/没有可继续/);
  await router.close();
});
test('tool errors are returned to the model instead of claiming a search succeeded',async()=>{
  const rpc:Rpc={async request(){throw Error('method not supported');},onEvent(){return ()=>{};},async close(){}};
  const router=new CodexRouter(rpc,'/work');let n=0;const out:string[]=[];
  const c=new AweiController({async ask(p){if(n++===0)return '{"action":"content_search","query":"埃及"}';assert.match(p,/method not supported/);return '{"action":"clarify","question":"正文接口不可用，暂时不能核对答案。"}';},async close(){}},router,{async release(){return '';},async quit(){return '';},async off(){return '';}});
  await c.handle('u','搜索',async t=>{out.push(t);});assert.match(out.at(-1)!,/不可用/);await router.close();
});
test('web demo returns only the fixed public URL without reading or publishing private content',async()=>{
  const rpc=new SearchBackend(),router=new CodexRouter(rpc,'/work'),out:string[]=[];
  const c=new AweiController({async ask(){return '{"action":"web_demo"}';},async close(){}},router,{async release(){return '';},async quit(){return '';},async off(){return '';}});
  await c.handle('u','打开网页版演示',async t=>{out.push(t);});assert.match(out.at(-1)!,/https:\/\/seanzhang9999.github.io/);assert.match(out.at(-1)!,/未上传/);assert.equal(rpc.calls.length,0);await router.close();
});
