import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { CodexInput } from "./attachments.js";
import {
  CodexRpc,
  visibleMessages,
  type CodexServerConfig,
  type Rpc,
  type Thread,
  type ThreadSummary,
  type Turn,
} from "./client.js";

export type Reply = ((text: string) => Promise<void>) & { attachments?: (text: string, cwd: string) => Promise<void> };
const help = [
  "阿维 · WorkHub 助手：说“阿维，帮我找会话”，或使用以下精确命令。",
  "/acp list [关键词] — 查找最近会话",
  "/acp more — 下一页",
  "/acp use <编号或完整ID> — 选择会话",
  "/acp current — 当前目标",
  "/acp recent [编号或ID] — 最近6条文本消息",
  "/acp reply <原文> — 发给当前目标",
  "/acp send <编号或ID> <原文> — 发给指定目标",
  "/acp result — 查看本次发送的状态/结果",
  "/acp new — 在当前项目创建并选中新会话",
  "/acp off — 返回原来的 ACP 聊天（不释放）",
  "/acp codex quit — 正常退出 Codex 桌面 App（可能中断桌面任务）",
  "/acp release-all — 释放桥接持有的全部会话（忙碌时拒绝）",
  "选中目标后，文本、图片和文件会直接发给该目标；最终回复中的本地文件链接会作为附件发送。编号只对应你上次看到的列表。",
].join("\n");
interface UserState {
  list: ThreadSummary[];
  selected?: ThreadSummary;
  cursor?: string | null;
  query?: string;
  contentSearch?: boolean;
  seenIds?: Set<string>;
  result?: string;
  listAt?: number;
  history?: { threadId: string; cursor?: string | null; text: string };
}
interface Flight {
  threadId: string;
  turnId?: string;
  early: Turn[];
  items: Map<string, Map<string, any>>;
  reply: Reply;
  user: UserState;
  timer: NodeJS.Timeout;
  title: string;
  cwd: string;
}
export class CodexRouter {
  private assistantSessionIds = new Set<string>();
  private hiddenFile?: string;
  private internalCwd?: string;
  configureInternalSessions(storageDir: string): void {
    this.internalCwd = path.resolve(storageDir, "awei-workspace");
    this.hiddenFile = path.join(storageDir, "internal-session-ids.json");
    if (existsSync(this.hiddenFile)) {
      const ids: unknown = JSON.parse(readFileSync(this.hiddenFile, "utf8"));
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error("内部会话记录格式错误");
      for (const id of ids) this.assistantSessionIds.add(id);
    }
  }
  hideAssistantSession(id: string): void {
    if (this.assistantSessionIds.has(id)) return;
    this.assistantSessionIds.add(id);
    if (this.hiddenFile) {
      mkdirSync(path.dirname(this.hiddenFile), { recursive: true, mode: 0o700 });
      const temp = this.hiddenFile + ".tmp";
      writeFileSync(temp, JSON.stringify([...this.assistantSessionIds]), { mode: 0o600 });
      renameSync(temp, this.hiddenFile);
    }
  }
  private visiblePage(s: UserState, rows: ThreadSummary[], more: boolean): ThreadSummary[] {
    if (!more) s.seenIds = new Set();
    const seen = s.seenIds ??= new Set();
    return rows.filter(t => {
      // Dedicated workspace identifies older internal sessions after a restart.
      if (this.internalCwd && t.cwd && path.resolve(t.cwd) === this.internalCwd) this.hideAssistantSession(t.id);
      if (this.assistantSessionIds.has(t.id) || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }
  private users = new Map<string, UserState>();
  private fresh = new Set<string>();
  private attached = new Set<string>();
  private flights = new Map<string, Flight>();
  private unsubscribe: () => void;
  private delivering = new Set<Promise<void>>();
  private approvals = new Set<string>();
  private releasing = false;
  constructor(
    private rpc: Rpc,
    private cwd: string,
    private timeoutMs = 600_000,
  ) {
    this.unsubscribe = rpc.onEvent((method, params) =>
      this.event(method, params),
    );
  }
  static create(config: CodexServerConfig, cwd: string): CodexRouter {
    return new CodexRouter(new CodexRpc(config), cwd, config.turnTimeoutMs);
  }
  async assertReleasable(): Promise<number> {
    if (this.releasing || this.flights.size || this.delivering.size || this.approvals.size)
      throw new Error("目标路由有执行中任务、审批或附件传输，请完成后再释放。");
    let cursor: string | null | undefined;
    const ids = new Set(this.attached);
    do {
      const page = await this.rpc.request<{ data: string[]; nextCursor?: string | null }>("thread/loaded/list", { cursor });
      for (const id of page.data) ids.add(id);
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) {
      const { thread } = await this.rpc.request<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: false });
      if (thread.status?.type !== "idle" && thread.status?.type !== "notLoaded")
        throw new Error(`会话 ${id} 仍在执行或状态不确定，未释放。`);
    }
    return ids.size;
  }
  async releaseAll(): Promise<number> {
    const count = await this.assertReleasable();
    if (!this.rpc.reset) throw new Error("当前连接不支持安全释放并重连。");
    this.releasing = true;
    try {
      await this.rpc.reset();
      this.attached.clear();
      this.fresh.clear();
      this.approvals.clear();
      for (const user of this.users.values()) { user.selected = undefined; user.history = undefined; }
      return count;
    } finally { this.releasing = false; }
  }
  async handleInput(userId: string, input: CodexInput[], reply: Reply): Promise<void> {
    try {
      const s = this.state(userId);
      await this.send(s, await this.target(s), input, reply);
    } catch (e) { await reply(`发送失败：${e instanceof Error ? e.message : String(e)}`); }
  }
  assistantContext(userId: string) {
    const s = this.state(userId);
    const valid = !!s.listAt && Date.now() - s.listAt < 10 * 60_000;
    return {
      now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      current: s.selected ? { id: s.selected.id, name: title(s.selected) } : null,
      candidates: valid ? s.list.map((t, i) => ({ number: i + 1, id: t.id, name: title(t), createdAt: t.createdAt, updatedAt: t.updatedAt, snippet: t.snippet })) : [],
      candidatesExpired: !!s.list.length && !valid,
      hasMore: valid && !!s.cursor,
      history: s.history?.text,
    };
  }
  async assistantSearch(userId: string, query = "", more = false, content = false): Promise<string> {
    const s = this.state(userId);
    if (more && (!s.cursor || !s.listAt || Date.now() - s.listAt >= 10 * 60_000))
      throw new Error("候选列表没有下一页或已过期，请重新查找。");
    const term = more ? s.query : query;
    const useContent = more ? s.contentSearch : content;
    if (useContent && !term?.trim()) throw new Error("正文搜索需要关键词。");
    const params = { limit: useContent ? 12 : 50, sourceKinds: [], ...(term ? { searchTerm: term } : {}), ...(more ? { cursor: s.cursor } : {}) };
    const page = useContent
      ? await this.rpc.request<{ data: { thread: ThreadSummary; snippet: string }[]; nextCursor?: string | null }>("thread/search", params)
          .then(p => ({ ...p, data: p.data.map(hit => ({ ...hit.thread, snippet: hit.snippet.slice(0, 1800) })) }))
      : await this.rpc.request<{ data: ThreadSummary[]; nextCursor?: string | null }>("thread/list", params);
    s.contentSearch = useContent;
    s.list = this.visiblePage(s, page.data, more);
    s.listAt = Date.now(); s.cursor = page.nextCursor; s.query = term;
    return this.assistantCandidates(userId);
  }
  assistantCandidates(userId: string): string {
    const c = this.assistantContext(userId);
    return c.candidates.length ? c.candidates.map(t => `${t.number}. ${t.name}${t.snippet ? "\n命中：" + t.snippet.replace(/\s+/g, " ").slice(0, 180) : ""}`).join("\n") +
      "\n说“阿维，切到第几个”即可选择。" + (c.hasMore ? " 还可以说“阿维，下一页会话”。" : "") : (c.hasMore ? "本页没有新的可见会话，可以说“阿维，下一页会话”。" : "没有找到匹配会话。");
  }
  assistantSelect(userId: string, ref: string): string {
    const s = this.state(userId);
    const c = this.assistantContext(userId);
    const found = c.candidates.find(t => t.id === ref || String(t.number) === ref);
    if (!found) throw new Error("目标不在当前有效候选列表中，请让阿维重新查找。");
    s.selected = s.list.find(t => t.id === found.id)!;
    s.history = undefined;
    return `已切换到「${found.name}」。下一条普通消息会发给这个会话。`;
  }
  async assistantHistory(userId: string, ref: string | undefined, count: number, earlier: boolean): Promise<string> {
    const s = this.state(userId);
    let t = s.selected;
    if (ref) {
      const match = this.assistantContext(userId).candidates.find(x => x.id === ref || String(x.number) === ref);
      if (!match) throw new Error("目标不在有效候选列表中。");
      t = s.list.find(x => x.id === match.id);
    }
    if (!t) throw new Error("还没选择会话，请先让阿维找会话。");
    if (earlier && (s.history?.threadId !== t.id || !s.history.cursor))
      throw new Error("没有可继续向前读取的页面，请先查看最近对话。");
    const page = await this.rpc.request<{ data: Turn[]; nextCursor?: string | null }>("thread/turns/list", {
      threadId: t.id, limit: Math.min(20, Math.max(1, count)), sortDirection: "desc", itemsView: "full",
      ...(earlier ? { cursor: s.history!.cursor } : {}),
    });
    const chunks: string[] = [];
    for (const turn of [...page.data].reverse()) for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = item.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
        if (text) chunks.push(`用户：${text}`);
      } else if (item.type === "agentMessage" && item.phase !== "commentary" && item.text) chunks.push(`助手：${item.text}`);
    }
    const raw = chunks.join("\n\n") || "本页没有可见文本（附件、工具及思考过程未展示）。";
    const text = `「${title(t)}」${earlier ? "更早" : "最近"} ${page.data.length} 轮对话\n${raw.slice(0, 16000)}` +
      (raw.length > 16000 ? "\n[本页文本过长已截断；可重新请求更少轮次]" : "") +
      (page.nextCursor ? "\n可说“阿维，再往前看”。" : "\n已到可读取历史的起点。");
    s.history = { threadId: t.id, cursor: page.nextCursor, text };
    return text;
  }
  researchOccurrences(threadId: string, searchTerm: string, cursor?: string) {
    return this.rpc.request<{ data: { turnId: string; snippet: string; turnCursor: string }[]; nextCursor?: string | null }>(
      "thread/searchOccurrences", { threadId, searchTerm, limit: 5, ...(cursor ? { cursor } : {}) });
  }
  researchTurns(threadId: string, cursor: string | undefined, count: number) {
    return this.rpc.request<{ data: Turn[]; nextCursor?: string | null }>("thread/turns/list", {
      threadId, limit: Math.min(6, Math.max(1, count)), sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}),
    });
  }
  selected(userId: string): boolean {
    return !!this.users.get(userId)?.selected;
  }
  private state(id: string): UserState {
    let s = this.users.get(id);
    if (!s) {
      s = { list: [] };
      this.users.set(id, s);
    }
    return s;
  }
  private async target(s: UserState, ref?: string): Promise<ThreadSummary> {
    if (!ref) {
      if (!s.selected)
        throw new Error("尚未选择会话。先 /acp list，再 /acp use 编号。");
      return s.selected;
    }
    if (/^\d+$/.test(ref)) {
      const t = s.list[Number(ref) - 1];
      if (!t) throw new Error("编号不在你上次看到的列表里。");
      return t;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(ref))
      throw new Error("请使用列表编号或完整会话 ID。");
    return (
      await this.rpc.request<{ thread: Thread }>("thread/read", {
        threadId: ref,
        includeTurns: false,
      })
    ).thread;
  }
  async handle(userId: string, text: string, reply: Reply): Promise<void> {
    const s = this.state(userId);
    const match = text.trim().match(/^\/acp(?:\s+(\S+))?(?:\s+([\s\S]*))?$/);
    try {
      if (!match) {
        await this.send(s, await this.target(s), text, reply);
        return;
      }
      const cmd = (match[1] ?? "help").toLowerCase(),
        args = match[2] ?? "";
      switch (cmd) {
        case "help":
          await reply(help);
          break;
        case "list":
        case "more": {
          if (cmd === "more" && !s.cursor)
            throw new Error("没有下一页。使用 /acp list 刷新。");
          if (cmd === "more" && s.contentSearch) {
            await reply(await this.assistantSearch(userId, "", true));
            break;
          }
          const r = await this.rpc.request<{
            data: ThreadSummary[];
            nextCursor?: string | null;
          }>("thread/list", {
            limit: 10,
            sourceKinds: [],
            ...(cmd === "more"
              ? {
                  cursor: s.cursor,
                  ...(s.query ? { searchTerm: s.query } : {}),
                }
              : args
                ? { searchTerm: args }
                : {}),
          });
          s.list = this.visiblePage(s, r.data, cmd === "more");
          s.listAt = Date.now();
          s.cursor = r.nextCursor;
          if (cmd === "list") { s.query = args; s.contentSearch = false; }
          await reply(
            s.list
              .map(
                (t, i) =>
                  `${i + 1}. ${title(t)} [${t.status?.type ?? "未知"}]\n${t.id}`,
              )
              .join("\n\n") + (s.cursor ? "\n\n/acp more 查看下一页" : "") ||
              "没有找到会话。",
          );
          break;
        }
        case "use": {
          if (!args) throw new Error("用法：/acp use 编号或ID");
          const t = await this.target(s, args);
          s.selected = t;
          s.history = undefined;
          await reply(`已选择：${title(t)}\n${t.id}\n选择不会恢复或启动任务。`);
          break;
        }
        case "current": {
          const t = await this.target(s);
          await reply(`当前：${title(t)}\n${t.id}`);
          break;
        }
        case "recent": {
          const t = await this.target(s, args || undefined);
          const r = await this.rpc.request<{ thread: Thread }>("thread/read", {
            threadId: t.id,
            includeTurns: true,
          });
          await reply(
            `【${title(t)}】\n${visibleMessages(r.thread.turns ?? [])}`,
          );
          break;
        }
        case "reply":
          if (!args.trim()) throw new Error("用法：/acp reply 消息原文");
          await this.send(s, await this.target(s), args, reply);
          break;
        case "send": {
          const parts = args.match(/^(\S+)\s+([\s\S]+)$/);
          if (!parts) throw new Error("用法：/acp send 编号或ID 消息原文");
          await this.send(s, await this.target(s, parts[1]), parts[2], reply);
          break;
        }
        case "result":
          await reply(s.result ?? "尚无发送记录。");
          break;
        case "off":
          s.selected = undefined;
          s.history = undefined;
          await reply(
            "已返回原 ACP 聊天；已发送任务继续执行，回复仍标注原目标。",
          );
          break;
        case "new": {
          if (args) throw new Error("用法：/acp new（当前项目）");
          const r = await this.rpc.request<{ thread: Thread }>("thread/start", {
            cwd: this.cwd,
            historyMode: "legacy",
          });
          this.attached.add(r.thread.id);
          this.fresh.add(r.thread.id);
          s.selected = r.thread;
          s.history = undefined;
          await reply(`已新建并选择：${r.thread.id}`);
          break;
        }
        default:
          throw new Error(
            `未知命令 /acp ${cmd}。使用 /acp help。此命令未发送给模型。`,
          );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await reply(
        msg.includes("active writer")
          ? "目标会话由另一个 Codex 服务持有，当前连接不能接管。未发送消息、未新建替代会话；请连接原服务或选择其他会话。"
          : `操作失败：${msg}`,
      );
    }
  }
  private async send(
    user: UserState,
    t: ThreadSummary,
    text: string | CodexInput[],
    reply: Reply,
  ): Promise<void> {
    if (this.releasing) throw new Error("正在释放会话，请稍后发送。");
    if (this.flights.has(t.id))
      throw new Error(
        "这个目标还有一条桥接请求未结束。使用 /acp result 查看，稍后再发。",
      );
    const f: Flight = {
      threadId: t.id,
      early: [],
      items: new Map(),
      reply,
      user,
      title: title(t),
      cwd: t.cwd || this.cwd,
      timer: setTimeout(
        () =>
          this.finish(
            t.id,
            "等待超时；任务可能仍在运行，不会自动重发。请 /acp recent 检查。",
          ),
        this.timeoutMs,
      ),
    };
    this.flights.set(t.id, f);
    try {
      if (!this.attached.has(t.id)) {
        const r = await this.rpc.request<{ thread: Thread }>("thread/resume", {
          threadId: t.id,
        });
        this.attached.add(t.id);
        f.cwd = r.thread.cwd || f.cwd;
        if (r.thread.status?.type === "active")
          throw new Error("目标正在执行其他任务；本条消息未发送，请稍后再试。");
        this.attached.add(t.id);
      }
      if (this.attached.has(t.id) && !this.fresh.has(t.id)) {
        const state = await this.rpc.request<{ thread: Thread }>(
          "thread/read",
          { threadId: t.id, includeTurns: false },
        );
        f.cwd = state.thread.cwd || f.cwd;
        if (state.thread.status?.type === "active")
          throw new Error("目标正在执行其他任务；本条消息未发送，请稍后再试。");
      }
      const result = await this.rpc.request<{ turn: Turn }>("turn/start", {
        threadId: t.id,
        input: [
          ...(typeof text === "string" ? [{ type: "text", text }] : text),
          ...(reply.attachments ? [{ type: "text", text: "[微信桥接附件交付说明] 如用户要求交付文件或图片，请在当前会话工作目录内保存文件，并在最终回复使用 [文件名](<绝对路径>) 或 ![图片](<绝对路径>) 链接，桥接会读取该文件并作为微信附件发送。单文件最多 25 MiB，每轮最多 10 个；源代码引用请带 :行号，以免作为附件发送。" }] : []),
        ],
      });
      this.fresh.delete(t.id);
      f.turnId = result.turn.id;
      user.result = `【${f.title}】已发送\n任务：${t.id}\n轮次：${f.turnId}`;
      await reply(user.result);
      const completed = f.early.find((x) => x.id === f.turnId);
      if (completed) this.completed(f, completed);
    } catch (e) {
      clearTimeout(f.timer);
      this.flights.delete(t.id);
      throw e;
    }
  }
  private event(method: string, params: any): void {
    if (method === "connection/closed") {
      for (const id of [...this.flights.keys()])
        this.finish(id, "连接已断开，发送/完成状态可能不确定；不会自动重发。");
      return;
    }
    if (method === "server/request") {
      if (params.params?.threadId) this.approvals.add(params.params.threadId);
      const f = this.flights.get(params.params?.threadId);
      if (f) {
        f.user.result = `【${f.title}】桥接服务正在等待审批或工具处理；当前桥接未接入审批界面，桌面端的另一服务无法代为处理，桥接不会自动批准。`;
        void f.reply(f.user.result).catch(() => {});
      }
      return;
    }
    if (method === "item/completed") {
      const f = this.flights.get(params.threadId);
      if (f && params.item?.type === "agentMessage" && params.turnId) {
        let items = f.items.get(params.turnId);
        if (!items && f.items.size < 8) {
          items = new Map();
          f.items.set(params.turnId, items);
        }
        if (items && items.size < 128) items.set(params.item.id, params.item);
      }
      return;
    }
    if (method !== "turn/completed") return;
    this.approvals.delete(params.threadId);
    const f = this.flights.get(params.threadId);
    if (!f) return;
    if (!f.turnId) {
      if (f.early.length < 8) f.early.push(params.turn);
      return;
    }
    if (params.turn?.id === f.turnId) this.completed(f, params.turn);
  }
  private completed(f: Flight, turn: Turn): void {
    const items = turn.items?.length
      ? turn.items
      : [...(f.items.get(turn.id)?.values() ?? [])];
    const text = items
      .filter((i) => i.type === "agentMessage" && i.phase !== "commentary")
      .map((i) => i.text ?? "")
      .join("\n");
    this.finish(
      f.threadId,
      `轮次 ${turn.id}：${turn.status}\n${text || turn.error?.message || "本轮完成，无最终文本。"}`,
      text,
    );
  }
  private finish(id: string, text: string, finalText?: string): void {
    const f = this.flights.get(id);
    if (!f) return;
    clearTimeout(f.timer);
    this.flights.delete(id);
    f.user.result = `【${f.title}】\n${text}`;
    const delivery = f.reply(f.user.result).then(async () => {
      if (finalText && f.reply.attachments) await f.reply.attachments(finalText, f.cwd);
    }).catch(() => {});
    this.delivering.add(delivery);
    void delivery.finally(() => this.delivering.delete(delivery));
  }
  async close(): Promise<void> {
    this.unsubscribe();
    for (const f of this.flights.values()) clearTimeout(f.timer);
    this.flights.clear();
    await this.rpc.close();
  }
}
function title(t: ThreadSummary): string {
  return (t.name || t.preview || "未命名会话")
    .replace(/\s+/g, " ")
    .slice(0, 70);
}
