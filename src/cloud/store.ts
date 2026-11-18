import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import type { WeixinMessage } from '../weixin/types.js';
export interface Task { id:string; owner:string; original:string; model:string; session:string|null; cwd:string; status:string; result:string; }
export class Store {
  db:DatabaseSync;
  constructor(file:string) {
    this.db=new DatabaseSync(file); this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,original TEXT NOT NULL,model TEXT NOT NULL,session TEXT,cwd TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,task TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,usage TEXT,result TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,task TEXT NOT NULL,owner TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL);
    `);
  }
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  get(k:string):string {return (this.db.prepare('SELECT v FROM meta WHERE k=?').get(k) as any)?.v??'';}
  set(k:string,v:string){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,v);}
  ingest(messages:WeixinMessage[],cursor:string,owner:string){return this.transaction(()=>{
    for(const m of messages){
      if(m.message_type!==1||m.from_user_id!==owner||m.group_id)continue;
      const source=m.message_id??m.client_id??m.seq;
      if(source===undefined||!m.context_token)continue;
      const id=createHash('sha256').update(owner+':'+String(source)).digest('hex');
      this.set('context:'+owner,m.context_token);
      this.db.prepare('INSERT OR IGNORE INTO inbox(id,owner,body) VALUES(?,?,?)').run(id,owner,JSON.stringify(m));
    }
    if(cursor)this.set('cursor',cursor);
  });}
  next():{id:string;owner:string;body:string}|undefined{return this.db.prepare("SELECT id,owner,body FROM inbox WHERE status='pending' ORDER BY rowid LIMIT 1").get() as any;}
  claim(id:string){return Number(this.db.prepare("UPDATE inbox SET status='processing' WHERE id=? AND status='pending'").run(id).changes)===1;}
  done(id:string){this.db.prepare("UPDATE inbox SET status='done' WHERE id=?").run(id);}
  task(id:string,owner:string):Task|undefined{return this.db.prepare('SELECT * FROM tasks WHERE id=? AND owner=?').get(id,owner) as any;}
  list(owner:string):Task[]{return this.db.prepare('SELECT * FROM tasks WHERE owner=? ORDER BY rowid DESC LIMIT 20').all(owner) as any;}
  enqueue(owner:string,text:string){
    for(let i=0;i<text.length;i+=1800)this.db.prepare('INSERT INTO outbox(id,owner,body) VALUES(?,?,?)').run('awei-'+randomUUID(),owner,text.slice(i,i+1800));
  }
  recover(){this.transaction(()=>{
    const pending=this.db.prepare("SELECT owner FROM inbox WHERE status='processing'").all() as any[];
    for(const r of pending)this.enqueue(r.owner,'有一条入站消息在重启时处理中，执行结果需核对；未自动重发给模型，请查看任务列表。');
    const interrupted=this.db.prepare("SELECT id,owner FROM tasks WHERE status IN ('running','waiting_approval','queued')").all() as any[];
    this.db.exec("UPDATE tasks SET status='unknown' WHERE status IN ('running','waiting_approval','queued'); UPDATE turns SET status='unknown' WHERE status IN ('running','queued'); UPDATE approvals SET status='expired' WHERE status='pending'; UPDATE inbox SET status='unknown' WHERE status='processing';");
    for(const t of interrupted)this.enqueue(t.owner,`任务 ${t.id} 在服务重启时中断，结果未知；未自动重跑。请先查看状态或成果，再明确继续。`);
  });}
  close(){this.db.close();}
}
