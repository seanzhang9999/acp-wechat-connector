#!/usr/bin/env node
import {mkdir,readFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import {writeFileSync,renameSync,rmSync} from 'node:fs';
import {loginQrPng} from '../src/cloud/login-qr.js';
import {login,loadToken} from '../src/weixin/auth.js';
import {Store} from '../src/cloud/store.js';
import {CloudController,safeError} from '../src/cloud/controller.js';
import {AcpExecutor} from '../src/cloud/executor.js';
import {DeepSeekLanguageService} from '../src/cloud/deepseek.js';
import {poll,send,requestIlink} from '../src/cloud/transport.js';
import {safeFile} from '../src/cloud/files.js';
import {uploadFileMedia,sendFileItem} from '../src/weixin/send.js';
process.umask(0o007);
const state=process.env.AWEI_STATE_DIR||'/var/lib/awei-wechat';
await mkdir(state,{recursive:true,mode:0o700});
if(process.argv.includes('--login')){
 if(loadToken(state)){console.log('已存在独立微信登录态；未覆盖。先检查服务状态。');process.exit(0);}
 const qrFile=path.join(state,'wechat-login.png');
 try{await login({baseUrl:'https://ilinkai.weixin.qq.com',storageDir:state,log:m=>{if(!m.startsWith('Bot ID:'))console.log(m);},renderQrUrl:url=>{
  writeFileSync(qrFile+'.new',loginQrPng(url),{mode:0o600});renameSync(qrFile+'.new',qrFile);
  console.log('清晰二维码图片已生成：'+qrFile);
  if(!process.argv.includes('--qr-image-only'))qrcode.generate(url,{small:true});
 }});}finally{rmSync(qrFile,{force:true});rmSync(qrFile+'.new',{force:true});}
 await chmod(path.join(state,'token.json'),0o600);console.log('微信配对已保存；此命令没有启动消息轮询。');process.exit(0);
}
const store=new Store(path.join(state,'tasks.sqlite'));await chmod(path.join(state,'tasks.sqlite'),0o600);
if(process.argv.includes('--status')){console.log(JSON.stringify({health:store.get('health'),tasks:store.db.prepare('SELECT status,COUNT(*) count FROM tasks GROUP BY status').all(),outbox:store.db.prepare('SELECT status,COUNT(*) count FROM outbox GROUP BY status').all()}));store.close();process.exit(0);}
const token=loadToken(state);if(!token?.token||!token.userId)throw Error('wechat_login_required');
let deepseek:DeepSeekLanguageService|undefined;
if(process.env.DEEPSEEK_MODEL){
 const credential=process.env.CREDENTIALS_DIRECTORY?path.join(process.env.CREDENTIALS_DIRECTORY,'deepseek.key'):process.env.DEEPSEEK_KEY_FILE;
 if(!credential)throw Error('deepseek_key_missing');const key=(await readFile(credential,'utf8')).trim();if(!key)throw Error('deepseek_key_missing');
 deepseek=new DeepSeekLanguageService(key,process.env.DEEPSEEK_MODEL);
 if(!(await deepseek.models()).includes(process.env.DEEPSEEK_MODEL))throw Error('deepseek_model_unavailable');
}
const controller=new CloudController(store,new AcpExecutor(process.env.AGY_SOCKET||'/run/awei-acp.sock'),process.env.AWEI_WORKSPACE_ROOT||'/var/lib/awei-workspaces',path.join(state,'usage'),process.env.AGY_MODEL_ID||'claude-opus-4-6-thinking',deepseek);
store.recover();store.set('health',deepseek?'online_deepseek':'online_direct');
let stopping=false;let authExpired=false;
const stop=()=>{stopping=true;controller.active?.abort.abort();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function monitor(){let fails=0;while(!stopping){try{const r=await poll(token!,store.get('cursor'));if(stopping)break;store.ingest(r.msgs??[],r.get_updates_buf??'',token!.userId,Date.parse(token!.savedAt)||0);fails=0;}catch(e){const code=safeError(e);if(code==='ilink_auth_expired'){authExpired=true;store.set('health','waiting_wechat_auth');stop();break;}store.set('last_poll_error',code);await sleep(Math.min(30000,1000*2**Math.min(++fails,5)));}}}
async function inbox(){while(!stopping){const row=store.next();if(row)await controller.handle(row);else await sleep(300);}}
async function outbox(){while(!stopping){const row=store.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next<=? ORDER BY rowid LIMIT 1").get(Date.now()) as any;
 if(!row){await sleep(400);continue;}
 try{
  const context=store.get('context:'+row.owner);
  if(row.id.startsWith('file-')){
   const body=JSON.parse(row.body);const opts={baseUrl:token!.baseUrl,token:token!.token,contextToken:context,cdnBaseUrl:'https://novac2c.cdn.weixin.qq.com/c2c'};
   if(!body.media){const file=await safeFile(body.root,body.name);body.media=await uploadFileMedia(row.owner,file.data,opts,{getUploadUrlFn:async p=>requestIlink(token!,'getuploadurl',p.body)});body.name=file.name;store.db.prepare('UPDATE outbox SET body=? WHERE id=?').run(JSON.stringify(body),row.id);}
   await sendFileItem(row.owner,body.media,body.name,opts,row.id,async p=>{await requestIlink(token!,'sendmessage',p.body);});
  }else await send(token!,row.owner,context,row.id,row.body);
  store.db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(row.id);
 }catch(e){const attempts=row.attempts+1;store.db.prepare('UPDATE outbox SET attempts=?,next=?,status=? WHERE id=?').run(attempts,Date.now()+Math.min(300000,2000*2**Math.min(attempts,7)),attempts>=8?'delivery_failed':'pending',row.id);store.set('last_send_error',safeError(e));}
}}
console.log(JSON.stringify({event:'awei_cloud_started',deepseek:!!deepseek,paired:true}));
await Promise.all([monitor(),inbox(),outbox()]);
if(controller.active)await controller.active.promise;
if(!authExpired)store.set('health','stopped');store.close();
