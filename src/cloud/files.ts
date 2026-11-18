import {open,realpath,lstat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decryptAesEcb,parseAesKey} from '../weixin/media.js';
import type {MessageItem} from '../weixin/types.js';
export const MAX_FILE=10*1024*1024;
export async function safeFile(root:string,name:string){
 if(path.isAbsolute(name)||name.split(/[\\/]/).includes('..'))throw Error('invalid_file_path');
 const resolved=await realpath(path.resolve(root,name));const base=await realpath(root);
 if(!resolved.startsWith(base+path.sep))throw Error('file_outside_task');
 const st=await lstat(resolved);if(!st.isFile()||st.size>MAX_FILE)throw Error('invalid_file_size');
 const fd=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await fd.stat();if(!stat.isFile()||stat.size>MAX_FILE)throw Error('invalid_file_size');return {name:path.basename(resolved),data:await fd.readFile()};}finally{await fd.close();}
}
export async function receiveFiles(cwd:string,items:MessageItem[]){
 const names:string[]=[];
 for(const item of items){
  if(item.type===1||item.type===3&&item.voice_item?.text)continue;
  const media=item.file_item?.media??item.image_item?.media;
  if(!media?.encrypt_query_param)throw Error('unsupported_attachment');
  const key=parseAesKey(media);if(!key||key.length!==16)throw Error('invalid_attachment_key');
  const r=await fetch('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param='+encodeURIComponent(media.encrypt_query_param),{signal:AbortSignal.timeout(45000),redirect:'error'});
  if(!r.ok||!r.body)throw Error('attachment_download_failed');
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const b of r.body as any){bytes+=b.length;if(bytes>MAX_FILE+32){await r.body.cancel().catch(()=>{});throw Error('attachment_too_large');}chunks.push(b);}
  const data=decryptAesEcb(Buffer.concat(chunks),key);if(data.length>MAX_FILE)throw Error('attachment_too_large');
  const supplied=item.file_item?.file_name??'image.bin';const clean=path.basename(supplied).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(-100)||'file';
  const name='input-'+randomUUID().slice(0,8)+'-'+clean;await writeFile(path.join(cwd,name),data,{flag:'wx',mode:0o660});names.push(name);
 }
 return names;
}
