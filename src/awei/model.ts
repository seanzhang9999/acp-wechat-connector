import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { killAgentAndWait } from "../acp/agent-manager.js";

export interface LanguageService { beginRequest?(text: string): Promise<void>; contextStatus?(): string; ask(prompt: string): Promise<string>; close(): Promise<void> }
export interface RotationOptions { usageRatio?: number; maxCalls?: number; maxCharacters?: number }
export interface LanguageConfig { command: string; args: string[]; env?: Record<string, string>; cwd: string }
/** Separate ACP session using the existing provider/account, not the business session. */
export class AcpLanguageService implements LanguageService {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientSideConnection;
  private sessionId?: string;
  private chunks = "";
  private toolRequested = false;
  private busy = false;
  private usage?: { used: number; size: number };
  private calls = 0;
  private characters = 0;
  private rotations = 0;
  private policy: Required<RotationOptions>;
  constructor(private config: LanguageConfig, private onSession: (id: string) => void = () => {}, private timeoutMs = 90_000, rotation: RotationOptions = {}) {
    this.policy = { usageRatio: rotation.usageRatio ?? 0.75, maxCalls: rotation.maxCalls ?? 80, maxCharacters: rotation.maxCharacters ?? 240_000 };
    if (!(this.policy.usageRatio > 0 && this.policy.usageRatio < 1) || !Number.isInteger(this.policy.maxCalls) || this.policy.maxCalls < 1 || !Number.isInteger(this.policy.maxCharacters) || this.policy.maxCharacters < 1) throw Error("阿维上下文轮换参数无效。");
  }
  status() { return { usage: this.usage ?? null, calls: this.calls, characters: this.characters, rotations: this.rotations, policy: this.policy }; }
  contextStatus(): string {
    return `阿维：自动上下文轮换已启用。\n${this.usage ? `最近上报用量：${this.usage.used}/${this.usage.size} tokens（${Math.round(this.usage.used / this.usage.size * 100)}%）。` : "尚未收到当前会话用量，不能计算准确百分比。"}\n用量阈值：${Math.round(this.policy.usageRatio * 100)}%；备用上限：${this.policy.maxCalls} 次模型调用或 ${this.policy.maxCharacters} 个累计字符。\n当前累计调用 ${this.calls} 次、字符 ${this.characters} 个；本进程自动轮换 ${this.rotations} 次。只在请求之间轮换，业务会话保持原样。`;
  }
  /** Called once per user request, never between research steps or while a prompt is running. */
  async beginRequest(text: string): Promise<void> {
    if (this.busy) throw Error("阿维正在处理上一条请求。");
    const reason = this.usage && this.usage.used / this.usage.size >= this.policy.usageRatio ? "usage" :
      this.calls >= this.policy.maxCalls ? "calls" : this.calls > 0 && this.characters + text.length >= this.policy.maxCharacters ? "characters" : undefined;
    if (this.sessionId && reason) {
      await this.close();
      this.rotations++;
      console.error(`[awei-context] rotated reason=${reason} count=${this.rotations}`);
      // Lazy creation: confirmation/help may not need a model at all. No business request is replayed.
    }
  }
  private async connect(): Promise<void> {
    if (this.connection && this.sessionId) return;
    await mkdir(this.config.cwd, { recursive: true, mode: 0o700 });
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd, env: { ...process.env, ...this.config.env },
      stdio: "pipe", shell: false, detached: process.platform !== "win32",
    });
    this.child = child;
    child.stderr.on("data", () => {});
    child.on("error", () => {});
    const denied = async (): Promise<never> => { throw new Error("阿维不提供文件或终端访问。"); };
    const client: acp.Client = {
      sessionUpdate: async params => {
        if (params.sessionId !== this.sessionId) return;
        const u = params.update;
        if (u.sessionUpdate === "usage_update" && Number.isFinite(u.used) && Number.isFinite(u.size) && u.used >= 0 && u.size > 0) {
          this.usage = { used: u.used, size: u.size };
        }
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
          this.chunks += u.content.text;
          if (this.chunks.length > 24_000) throw new Error("阿维输出超过限制。");
        }
        if (u.sessionUpdate === "tool_call") {
          this.toolRequested = true;
          void this.connection?.cancel({ sessionId: params.sessionId }).catch(() => {});
        }
      },
      requestPermission: async () => { this.toolRequested = true; return { outcome: { outcome: "cancelled" } }; },
      readTextFile: denied, writeTextFile: denied,
      extNotification: async () => {},
      extMethod: denied,
    };
    const connection = new acp.ClientSideConnection(() => client,
      acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    this.connection = connection;
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "workhub-awei", version: "0.16.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const session = await connection.newSession({ cwd: this.config.cwd, mcpServers: [] });
    this.sessionId = session.sessionId;
    this.onSession(session.sessionId);
    // Fail closed on adapters without the tested approval-required mode.
    if (!session.modes?.availableModes.some((m: { id: string }) => m.id === "read-only"))
      throw new Error("ACP Agent 未提供已适配的 read-only 模式，阿维暂不可用；原 /acp 命令仍可使用。");
    await connection.setSessionMode({ sessionId: session.sessionId, modeId: "read-only" });
  }
  async ask(prompt: string): Promise<string> {
    if (this.busy) throw new Error("阿维正在处理上一条请求。");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await this.connect();
          this.chunks = ""; this.toolRequested = false;
          this.calls++; this.characters += prompt.length;
          const result = await this.connection!.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: prompt }] });
          if (this.toolRequested) throw new Error("阿维尝试了管理范围之外的工具调用，本次操作未执行。");
          if (result.stopReason !== "end_turn") throw new Error(`阿维未正常完成理解（${result.stopReason}），未执行操作。`);
          if (!this.chunks.trim()) throw new Error("阿维没有返回可用结果。");
          this.characters += this.chunks.length;
          return this.chunks;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("阿维响应超时，未转发到业务会话。")), this.timeoutMs); }),
      ]);
    } catch (e) {
      await this.close();
      throw e;
    } finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
  async close(): Promise<void> {
    const child = this.child;
    if (child) await killAgentAndWait(child);
    this.child = undefined; this.connection = undefined; this.sessionId = undefined;
    this.chunks = "";
    this.usage = undefined; this.calls = 0; this.characters = 0;
  }
}
