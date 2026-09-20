import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startCodexDesktop,type DesktopStartDeps,type DesktopProcess} from '../src/codex/desktop.js';
import {WeChatAcpBridge} from '../src/bridge.js';
import {defaultConfig} from '../src/config.js';
import {AweiController} from '../src/awei/controller.js';
import {CodexRouter} from '../src/codex/router.js';
const command='/Applications/ChatGPT.app/Contents/Resources/codex';
const app={pid:10,ppid:1,executable:'/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'};
const server={pid:11,ppid:10,executable:command};
function deps(pages:DesktopProcess[][]){let n=0,launches=0;const d:DesktopStartDeps={platform:'darwin',async identity(){return {bundleId:'com.openai.codex',executable:'ChatGPT'};},async snapshot(){return pages[Math.min(n++,pages.length-1)];},async launch(p){assert.equal(p,'/Applications/ChatGPT.app');launches++;},async sleep(){}};return {d,count:()=>launches};}
test('launches once and verifies desktop-owned server, not unrelated bridge server',async()=>{
 const f=deps([[],[app,{...server,ppid:100}], [app,server]]);
 assert.match(await startCodexDesktop(command,f.d),/桌面已启动/);assert.equal(f.count(),1);
 const g=deps([[app,server]]);assert.match(await startCodexDesktop(command,g.d),/未重复启动/);assert.equal(g.count(),0);
 const h=deps([[],[app]]);await assert.rejects(startCodexDesktop(command,h.d,2),/等待超时/);assert.equal(h.count(),1);
});
test('rejects unsupported platforms, arbitrary binaries and wrong bundles before launch',async()=>{
 const f=deps([[]]);await assert.rejects(startCodexDesktop('codex',f.d),/绝对/);
 f.d.identity=async()=>({bundleId:'wrong',executable:'ChatGPT'});await assert.rejects(startCodexDesktop(command,f.d),/不是/);
 f.d.platform='linux';await assert.rejects(startCodexDesktop(command,f.d),/macOS/);assert.equal(f.count(),0);
});
const message=(text:string,user='owner')=>({message_type:1,from_user_id:user,context_token:'ctx',item_list:[{type:1,text_item:{text}}]});
test('owner start command needs no selected session; rejects other users and arguments',async()=>{
 const b=new WeChatAcpBridge(defaultConfig()) as any;b.tokenData={userId:'owner'};const out:string[]=[];let launches=0;
 b.sendReply=async(_u:string,_c:string,t:string)=>{out.push(t);};b.startDesktop=async()=>{launches++;return 'started';};
 await b.handleMessage(message('/acp codex start','other'));await b.handleMessage(message('/acp codex start --args malicious'));assert.equal(launches,0);
 await b.handleMessage(message('/acp codex start'));assert.equal(launches,1);assert.equal(out.at(-1),'started');
});
test('restore releases before starting; busy refusal never launches; launch failure preserves released result',async()=>{
 const b=new WeChatAcpBridge(defaultConfig()) as any;const events:string[]=[];
 b.releaseBridgeSessions=async()=>{events.push('release');return '已释放';};b.startDesktop=async()=>{events.push('start');return '已启动';};
 assert.match(await b.restoreDesktop(),/已释放[\s\S]*已启动/);assert.deepEqual(events,['release','start']);
 b.releaseBridgeSessions=async()=>{throw Error('busy');};events.length=0;await assert.rejects(b.restoreDesktop(),/busy/);assert.deepEqual(events,[]);
 b.releaseBridgeSessions=async()=> '已释放';b.startDesktop=async()=>{throw Error('timeout');};assert.match(await b.restoreDesktop(),/已经释放[\s\S]*codex start/);
});
test('natural restore requires matching confirmation, while start is direct',async()=>{
 const router=new CodexRouter({async request(){throw Error('unexpected');},onEvent(){return()=>{};},async close(){}},'/work');
 const plans=['restore','start'];const events:string[]=[];const out:string[]=[];
 const ctl=new AweiController({async ask(){return JSON.stringify({action:plans.shift()});},async close(){events.push('close');}},router,{async release(){return '';},async quit(){return '';},async off(){return '';},async start(){events.push('start');return 'started';},async restore(){events.push('restore');return 'restored';}});
 const reply=async(t:string)=>{out.push(t);};await ctl.handle('u','不聊了，恢复桌面',reply);assert.deepEqual(events,[]);
 await ctl.handle('u','确认恢复',reply);assert.deepEqual(events,['restore']);
 await ctl.handle('u','打开Codex',reply);assert.equal(events.at(-1),'start');await router.close();
});

test('restore keeps Awei provider alive while releasing business sessions',async()=>{
 const b=new WeChatAcpBridge(defaultConfig()) as any;const calls:string[]=[];
 b.awei={async close(){calls.push('awei-close');}};
 b.sessionManager={assertReleasable(){calls.push('acp-check');},async releaseAll(){calls.push('acp-release');return 1;}};
 b.codexRouter={async assertReleasable(){calls.push('router-check');},async releaseAll(){calls.push('router-release');return 1;}};
 b.startDesktop=async()=>{calls.push('desktop-start');return 'started';};
 await b.restoreDesktop();
 assert.deepEqual(calls,['acp-check','router-check','acp-release','router-release','desktop-start']);
});
