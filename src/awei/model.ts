import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { killAgentAndWait } from "../acp/agent-manager.js";

export interface LanguageService { ask(prompt: string): Promise<string>; close(): Promise<void> }
export interface LanguageConfig { command: string; args: string[]; env?: Record<string, string>; cwd: string }
/** Separate ACP session using the existing provider/account, not the business session. */
export class AcpLanguageService implements LanguageService {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientSideConnection;
  private sessionId?: string;
  private chunks = "";
  private toolRequested = false;
  private busy = false;
  constructor(private config: LanguageConfig, private onSession: (id: string) => void = () => {}, private timeoutMs = 90_000) {}
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
      clientInfo: { name: "workhub-awei", version: "0.12.0" },
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
          const result = await this.connection!.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: prompt }] });
          if (this.toolRequested) throw new Error("阿维尝试了管理范围之外的工具调用，本次操作未执行。");
          if (result.stopReason !== "end_turn") throw new Error(`阿维未正常完成理解（${result.stopReason}），未执行操作。`);
          if (!this.chunks.trim()) throw new Error("阿维没有返回可用结果。");
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
  }
}
