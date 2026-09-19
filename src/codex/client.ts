import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}
export interface ThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: { type: string };
}
export interface ThreadItem {
  type: string;
  text?: string;
  phase?: string;
  content?: Array<{ type: string; text?: string }>;
}
export interface Turn {
  id: string;
  status: string;
  items: ThreadItem[];
  error?: { message: string } | null;
}
export interface Thread extends ThreadSummary {
  turns?: Turn[];
}
export interface Rpc {
  request<T>(method: string, params: object): Promise<T>;
  onEvent(handler: (method: string, params: any) => void): () => void;
  close(): Promise<void>;
  reset?(): Promise<void>;
}

/** One persistent connection. Never spawn a second server per selected thread. */
export class CodexRpc implements Rpc {
  private process?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private handlers = new Set<(method: string, params: any) => void>();
  private closed = false;
  constructor(private config: CodexServerConfig) {}
  private connect(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Codex connection closed"));
    return (this.ready ??= this.open());
  }
  private async open(): Promise<void> {
    const p = spawn(this.config.command, this.config.args ?? ["app-server"], {
      stdio: "pipe",
      env: { ...process.env, ...this.config.env },
      shell: false,
    });
    this.process = p;
    // Drain stderr without logging prompts, identifiers or credentials.
    p.stderr.on("data", () => {});
    p.on("error", (e) => this.fail(e));
    p.on("exit", () =>
      this.fail(
        new Error(
          "Codex App Server connection exited. Check command/socket; no message was retried.",
        ),
      ),
    );
    createInterface({ input: p.stdout }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.id === "number" && !msg.method) {
        const waiting = this.pending.get(msg.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(msg.id);
        if (msg.error)
          waiting.reject(
            new Error(
              msg.error.message +
                (msg.error.data?.details ? `: ${msg.error.data.details}` : ""),
            ),
          );
        else waiting.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // Never auto-approve or answer another client's server requests.
        for (const h of this.handlers) h("server/request", msg);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg.method, msg.params ?? {});
      }
    });
    await this.raw("initialize", {
      clientInfo: { name: "wechat-acp-router", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.closed = true;
    for (const h of this.handlers)
      h("connection/closed", { message: error.message });
  }
  private raw<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out; delivery may be uncertain. Do not resend blindly.`,
          ),
        );
      }, this.config.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
    });
  }
  async request<T>(method: string, params: object): Promise<T> {
    await this.connect();
    return this.raw<T>(method, params);
  }
  onEvent(handler: (method: string, params: any) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async close(): Promise<void> {
    this.closed = true;
    const p = this.process;
    if (p && p.exitCode === null && p.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          p.off("exit", done);
          reject(new Error("桥接服务未确认退出；不能报告会话已释放。"));
        }, 10_000);
        p.once("exit", done);
        p.stdin.end();
        // This is our own child, never the desktop service.
        p.kill("SIGTERM");
      });
    }
    this.fail(new Error("Bridge connection closed."));
  }
  async reset(): Promise<void> {
    if (this.config.args?.some(arg => arg === "proxy" || arg === "daemon"))
      throw new Error("共享服务或代理连接不能通过关闭子进程保证释放；未断开连接。");
    await this.close();
    this.process = undefined;
    this.ready = undefined;
    this.closed = false;
  }

}

export function visibleMessages(turns: Turn[], count = 6): string {
  const messages: string[] = [];
  for (const turn of turns)
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = item.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (text) messages.push(`用户：${text}`);
      } else if (item.type === "agentMessage" && item.text)
        messages.push(`Codex：${item.text}`);
    }
  return (
    messages.slice(-count).join("\n\n").slice(-12000) ||
    "暂无可显示的文本消息。"
  );
}
