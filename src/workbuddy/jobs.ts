import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export interface RelayEvent { type: "text" | "image" | "file"; text?: string; path?: string; mimeType?: string; name?: string }
export interface RelayInput { text: string; voice?: boolean; files?: string[] }
export interface RelayJob { id: string; hash: string; state: "running" | "done" | "unknown"; events: RelayEvent[] }
/** One dedicated local session; receipt IDs are stable across MCP reconnects. */
export class RelayJobs {
  private jobs = new Map<string, RelayJob>();
  private active = false;
  private file: string;
  constructor(dir: string, private run: (input: RelayInput, emit: (event: RelayEvent) => void) => Promise<void>) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); this.file = path.join(dir, "relay-jobs.json");
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as RelayJob[];
      for (const job of saved) {
        if (job.state === "running") { job.state = "unknown"; job.events.push({ type: "text", text: "连接器重启，本次执行状态无法确认；请核对原会话，未自动重发。" }); }
        this.jobs.set(job.id, job);
      }
      this.save();
    }
  }
  private save() {
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify([...this.jobs.values()]), { mode: 0o600 }); renameSync(temp, this.file);
  }
  submit(id: string, input: RelayInput) {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.jobs.get(id);
    if (previous) { if (previous.hash !== hash) throw Error("该消息编号已用于不同内容，未提交。"); return this.poll(id); }
    if (this.active) throw Error("阿维正在处理上一条消息，请先查询结果；本条未提交。");
    if (this.jobs.size >= 1000) throw Error("本实例已有 1000 条消息记录；请先归档实例，未提交。");
    const job: RelayJob = { id, hash, state: "running", events: [] };
    this.jobs.set(id, job); this.active = true; this.save();
    const emit = (event: RelayEvent) => { job.events.push(event); this.save(); };
    void Promise.resolve().then(() => this.run(input, emit)).then(() => { job.state = "done"; }).catch(() => {
      job.state = "unknown"; job.events.push({ type: "text", text: "阿维接入执行异常，状态无法确认。请核对原会话；不要重新编号重发。" });
    }).finally(() => { this.active = false; this.save(); });
    return this.poll(id);
  }
  poll(id: string, cursor = 0) {
    const job = this.jobs.get(id); if (!job) throw Error("找不到该消息编号，未执行任何操作。");
    const events = job.events.slice(cursor, cursor + 20);
    return { id, state: job.state, cursor: cursor + events.length, hasMore: cursor + events.length < job.events.length, events,
      note: "done 表示本次路由处理结束，不代表操作成功；以事件中的执行结果为准。" };
  }
  status() { return { active: this.active, receipts: [...this.jobs.values()].slice(-5).map(({ id, state }) => ({ id, state })) }; }
}
