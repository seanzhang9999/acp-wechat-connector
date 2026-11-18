import { randomBytes } from 'node:crypto';
import type { TokenData } from '../weixin/auth.js';
import type { GetUpdatesResp } from '../weixin/types.js';
export async function requestIlink(token:TokenData,endpoint:string,body:object,timeout=40000,fetchFn:typeof fetch=fetch){
 const base=new URL(token.baseUrl);if(base.protocol!=='https:'||!(base.hostname==='ilinkai.weixin.qq.com'||base.hostname.endsWith('.weixin.qq.com')))throw Error('invalid_ilink_origin');
 const r=await fetchFn(new URL('/ilink/bot/'+endpoint,base),{method:'POST',headers:{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token',Authorization:`Bearer ${token.token}`,'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')},body:JSON.stringify({...body,base_info:{channel_version:'1.0.2'}}),signal:AbortSignal.timeout(timeout)});
 if(!r.ok)throw Error(`ilink_http_${r.status}`);
 const text=await r.text();if(text.length>2_000_000)throw Error('ilink_size_limit');const data=JSON.parse(text);
 if((data.ret??0)!==0||(data.errcode??0)!==0)throw Error((data.errcode===-14||data.ret===-14)?'ilink_auth_expired':'ilink_api_error');
 return data;
}
export async function poll(token:TokenData,cursor:string):Promise<GetUpdatesResp>{return requestIlink(token,'getupdates',{get_updates_buf:cursor});}
export async function send(token:TokenData,owner:string,context:string,id:string,text:string){
 if(!context)throw Error('missing_context');
 await requestIlink(token,'sendmessage',{msg:{from_user_id:'',to_user_id:owner,client_id:id,message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]}},15000);
}
