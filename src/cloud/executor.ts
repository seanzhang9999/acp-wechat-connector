import * as acp from '@agentclientprotocol/sdk';
import { connect } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { sanitizeTokens } from '../antigravity/probe.js';
export interface ExecutionInput {cwd:string;session?:string;model:string;prompt:string;signal:AbortSignal;
 onSession:(id:string)=>Promise<void>;onSubmitted:()=>Promise<void>;
 permission:(p:acp.RequestPermissionRequest)=>Promise<acp.RequestPermissionResponse>;}
export class AcpExecutor {
 constructor(private socketPath:string){}
 async run(input:ExecutionInput){
  const socket=connect(this.socketPath);await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',()=>reject(Error('executor_unavailable')));});
  let session='';let text='';let replay=true;let context:object|null=null;let cost:object|null=null;let changed=false;let currentModel=input.model;
  const denied=async():Promise<never>=>{throw Error('client_file_access_denied');};
  const connection=new acp.ClientSideConnection(()=>({
   requestPermission:async(p:acp.RequestPermissionRequest)=>p.sessionId===session&&!replay&&!input.signal.aborted?input.permission(p):{outcome:{outcome:'cancelled' as const}},
   readTextFile:denied,writeTextFile:denied,extMethod:denied,extNotification:async()=>{},
   sessionUpdate:async(p:acp.SessionNotification)=>{
    if(p.sessionId!==session||replay)return;const u=p.update;
    if(u.sessionUpdate==='agent_message_chunk'&&u.content.type==='text'){text+=u.content.text;if(text.length>200000){void connection.cancel({sessionId:session});throw Error('output_limit');}}
    if(u.sessionUpdate==='config_option_update'){const m=u.configOptions.find((o:acp.SessionConfigOption)=>o.category==='model'&&o.type==='select');if(m?.type==='select')currentModel=m.currentValue;}
    if(currentModel!==input.model)changed=true;
    if(u.sessionUpdate==='usage_update'){if(Number.isFinite(u.used)&&Number.isFinite(u.size))context={used:u.used,size:u.size};if(u.cost&&Number.isFinite(u.cost.amount))cost={amount:u.cost.amount,currency:u.cost.currency};}
   }
  }),acp.ndJsonStream(Writable.toWeb(socket),Readable.toWeb(socket) as ReadableStream<Uint8Array>));
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:()=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{abort=()=>{void connection.cancel({sessionId:session}).catch(()=>{});reject(Error('execution_cancelled'));};input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();});
  try{return await Promise.race([
   connection.closed.then(()=>{throw Error('executor_disconnected');}), stopped,
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('execution_timeout')),540000);}),
   (async()=>{
    const init=await connection.initialize({protocolVersion:acp.PROTOCOL_VERSION,clientInfo:{name:'awei-cloud',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
    if(input.session&&!init.agentCapabilities?.loadSession)throw Error('resume_unsupported');
    session=input.session??'';
    const state=input.session?await connection.loadSession({sessionId:input.session,cwd:input.cwd,mcpServers:[]}):await connection.newSession({cwd:input.cwd,mcpServers:[]});
    if(!input.session)session=(state as acp.NewSessionResponse).sessionId;
    await input.onSession(session);
    const options=(state.configOptions??[]) as acp.SessionConfigOption[];
    const selectors=options.filter(o=>o.category==='model'&&o.type==='select');
    if(selectors.length!==1)throw Error('model_selector_unsupported');const selector=selectors[0];
    if(selector.type!=='select')throw Error('model_selector_unsupported');
    const values=selector.options.flatMap(o=>'group'in o?o.options:[o]);
    if(!values.some(o=>o.value===input.model))throw Error('model_unavailable');
    const selected=await connection.setSessionConfigOption({sessionId:session,configId:selector.id,value:input.model});
    const confirmed=selected.configOptions.find((o:acp.SessionConfigOption)=>o.id===selector.id);
    if(confirmed?.type!=='select'||confirmed.currentValue!==input.model)throw Error('model_unconfirmed');
    // Never enable auto/accept-edits. Fail closed if no explicit manual mode exists.
    const mode=state.modes?.availableModes.find((m:acp.SessionMode)=>['default','ask','manual'].includes(m.id));
    if(!mode)throw Error('manual_mode_unavailable');
    await connection.setSessionMode({sessionId:session,modeId:mode.id});
    replay=false;
    await input.onSubmitted();
    const started=Date.now();
    const result=await connection.prompt({sessionId:session,prompt:[{type:'text',text:input.prompt}]});
    if(changed)throw Error('model_changed');
    return {sessionId:session,text,stopReason:result.stopReason,usage:{provider:'antigravity',accountingScope:input.session?'resumed_session_unverified':'fresh_session_single_prompt',acpPrompts:1,internalModelRequests:null,durationMs:Date.now()-started,tokens:sanitizeTokens(result.usage),context,sessionCost:cost,subscriptionRemaining:null}};
   })()
  ]);}finally{if(timer)clearTimeout(timer);input.signal.removeEventListener('abort',abort);socket.destroy();}
 }
}
