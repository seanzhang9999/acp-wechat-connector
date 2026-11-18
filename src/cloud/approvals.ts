import {randomBytes} from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import {Store} from './store.js';
export class Approvals {
 private waiting=new Map<string,{task:string;owner:string;expires:number;resolve:(allow:boolean)=>void}>();
 constructor(private store:Store,private ttl=120000){}
 async request(task:string,owner:string,p:acp.RequestPermissionRequest,signal:AbortSignal):Promise<acp.RequestPermissionResponse>{
  const option=p.options.find(o=>o.kind==='allow_once');if(!option||signal.aborted)return {outcome:{outcome:'cancelled'}};
  const id=randomBytes(8).toString('hex');const expires=Date.now()+this.ttl;
  const title=String(p.toolCall.title??'操作').replace(/[\u0000-\u001f]/g,' ').slice(0,300);
  const input=JSON.stringify(p.toolCall.rawInput??{});
  if(input.length>1200){this.store.enqueue(owner,`任务 ${task} 的工具参数超过微信审批展示上限，已拒绝；请缩小操作范围。`);return {outcome:{outcome:'cancelled'}};}
  this.store.transaction(()=>{
   this.store.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?)').run(id,task,owner,expires,'pending',title);
   this.store.db.prepare("UPDATE tasks SET status='waiting_approval' WHERE id=?").run(task);
   this.store.enqueue(owner,`任务 ${task} 请求一次授权：\n${title}\n参数摘要（不可信工具内容）：${input}\n两分钟内回复：\n/approve ${id}\n或 /deny ${id}\n请仅对你理解并同意的操作批准。`);
  });
  const allowed=await new Promise<boolean>(resolve=>{
   let settled=false;const finish=(yes:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);this.waiting.delete(id);resolve(yes);};
   const cancel=()=>finish(false);const timer=setTimeout(()=>finish(false),this.ttl);
   this.waiting.set(id,{task,owner,expires,resolve:finish});signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
  this.store.transaction(()=>{this.store.db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(allowed?'approved':'denied_or_expired',id);this.store.db.prepare("UPDATE tasks SET status='running' WHERE id=? AND status='waiting_approval'").run(task);});
  return allowed?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}};
 }
 resolve(owner:string,id:string,allow:boolean){const p=this.waiting.get(id);if(!p||p.owner!==owner||p.expires<=Date.now())return false;p.resolve(allow);return true;}
}
