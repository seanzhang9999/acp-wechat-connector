#!/usr/bin/env node
import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RelayLock, lockStatus, requestRelease, LockError, RELAY_VERSION } from "../src/workbuddy/lock.js";
import { RelayLifecycle } from "../src/workbuddy/lifecycle.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DedicatedCore } from "../src/workbuddy/core.js";
import { relayResult } from "../src/workbuddy/results.js";
import { RelayJobs } from "../src/workbuddy/jobs.js";
const configSchema = z.object({
  agent: z.object({ command: z.string().min(1), args: z.array(z.string()), cwd: z.string(), env: z.record(z.string(), z.string()).optional() }),
  codexServer: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  storageDir: z.string(), handoverGraceSeconds: z.number().int().min(0).max(86400).default(180), attachmentRoots: z.array(z.string()).default([]),
  aweiRotation: z.object({ usageRatio: z.number().gt(0).lt(1).optional(), maxCalls: z.number().int().positive().optional(), maxCharacters: z.number().int().positive().optional() }).optional(),
});
async function main() {
  const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith("--")));
  const files = args.filter(a => !a.startsWith("--"));
  if (files.length !== 1 || [...flags].some(f => !["--lock-status", "--release", "--take-over", "--force"].includes(f))) throw Error("Usage: awei-workbuddy config.json [--lock-status | --release | --take-over [--force]]");
  if (["--lock-status", "--release", "--take-over"].filter(f => flags.has(f)).length > 1 || flags.has("--force") && !flags.has("--take-over")) throw Error("操作参数互斥；--force 仅可与 --take-over 一起使用。");
  const file = path.resolve(files[0]);
  const config = configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  for (const value of [config.storageDir, config.agent.cwd, config.codexServer.command, ...config.attachmentRoots]) if (!path.isAbsolute(value)) throw Error("Directories and Codex binary must be absolute paths");
  if (flags.has("--lock-status")) { console.log(JSON.stringify(lockStatus(config.storageDir))); return; }
  if (flags.has("--release")) { const released = await requestRelease(config.storageDir); console.log(JSON.stringify(released)); if (!released.released) process.exitCode = 2; return; }
  const lock = new RelayLock(config.storageDir);
  await lock.acquire({ takeOver: flags.has("--take-over"), force: flags.has("--force"), legacyActive: () => {
    // Old zero-byte locks have no identity. Never reclaim if a matching legacy launch is still present.
    try {
      const rows = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 2000 });
      return rows.split("\n").some(line => { const m = line.trim().match(/^(\d+)\s+(.+)$/); return !!m && Number(m[1]) !== process.pid && /awei-workbuddy\.(?:js|ts)/.test(m[2]) && m[2].includes(file); });
    } catch { return true; }
  } });
  // Protocol uses stdout exclusively, including logs from shared components.
  console.log = (...args) => console.error(...args);
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    // userError has already redacted these lines. Keep a durable error-ID lookup even if the host discards stderr.
    const line = args.length === 1 && typeof args[0] === "string" ? args[0] : "";
    if (line.startsWith("[bridge-error ")) {
      try { appendFileSync(path.join(config.storageDir, "diagnostics.log"), new Date().toISOString() + " " + line + "\n", { mode: 0o600 }); } catch { /* stderr remains available */ }
    }
    originalWarn(...args);
  };
  const core = new DedicatedCore(config);
  const jobs = new RelayJobs(config.storageDir, (input, emit) => core.run(input, emit));
  const lifecycle = new RelayLifecycle(lock, jobs, core, config.handoverGraceSeconds);
  let stopping = false;
  const exitAfterResponse = () => { if (!stopping) { stopping = true; setTimeout(() => process.exit(0), 50); } };
  lock.onRelease(reason => lifecycle.release(reason), exitAfterResponse);
  const server = new McpServer({ name: "awei-dedicated-session", version: RELAY_VERSION });
  const result = (value: unknown) => relayResult(value, config.storageDir);
  server.registerTool("awei_message", { description: "专用会话唯一入口。原样转交每条用户消息、语音转写及附件；同一消息重试沿用 receiptId。不要自行回答或创建 WorkBuddy 业务任务。", inputSchema: {
    receiptId: z.string().min(1).max(160), text: z.string().max(100000), voice: z.boolean().optional(), files: z.array(z.string()).max(10).optional(),
  } }, async ({ receiptId, ...input }) => { if (!lifecycle.accepting()) throw Error("正在释放桥接，未接收新消息。"); return result(jobs.submit(receiptId, input)); });
  server.registerTool("awei_poll", { description: "查询转交结果。沿用回执和游标，按序原样回传文字；image/file 事件交给 WorkBuddy 原生附件发送。禁止将查询改成新提交。", inputSchema: {
    receiptId: z.string(), cursor: z.number().int().min(0).default(0),
  } }, async ({ receiptId, cursor }) => result(jobs.poll(receiptId, cursor)));
  server.registerTool("awei_status", { description: "检查专用阿维连接器及最近回执，不读取 WorkBuddy 会话。", inputSchema: {} }, async () => result({ version: RELAY_VERSION, ...jobs.status(), ...lockStatus(config.storageDir) }));
  server.registerTool("awei_release", { description: "用户主动停止专用桥或换会话时调用。忙碌拒绝；成功关闭本桥连接、保留历史并留出交接窗口。", inputSchema: { reason: z.string().max(300).optional() } }, async ({ reason }) => {
    const released = await lifecycle.release(reason);
    return result(released);
  });
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    try { await lifecycle.shutdown(); await lock.closeGate(); process.exit(0); }
    catch { process.exit(1); } // Retain lock on uncertain cleanup; next startup verifies owner death.
  };
  process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  const transport = new StdioServerTransport();
  const send = transport.send.bind(transport);
  transport.send = async message => {
    await send(message); // Exit only after the successful release response has been written.
    if ("result" in message && message.result && typeof message.result === "object") {
      const content = (message.result as { content?: Array<{ type?: string; text?: string }> }).content;
      try { if (content?.[0]?.type === "text" && JSON.parse(content[0].text ?? "{}").released === true) exitAfterResponse(); } catch { /* Other tool responses are unrelated. */ }
    }
  };
  await server.connect(transport);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Startup failed"); process.exit(error instanceof LockError ? 2 : 1); });
