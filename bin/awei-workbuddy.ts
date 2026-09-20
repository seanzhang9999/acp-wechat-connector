#!/usr/bin/env node
import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DedicatedCore } from "../src/workbuddy/core.js";
import { relayResult } from "../src/workbuddy/results.js";
import { RelayJobs } from "../src/workbuddy/jobs.js";
const configSchema = z.object({
  agent: z.object({ command: z.string().min(1), args: z.array(z.string()), cwd: z.string(), env: z.record(z.string(), z.string()).optional() }),
  codexServer: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  storageDir: z.string(), attachmentRoots: z.array(z.string()).default([]),
});
async function main() {
  const file = process.argv[2]; if (!file) throw Error("Usage: awei-workbuddy /absolute/path/to/relay-config.json");
  const config = configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  for (const value of [config.storageDir, config.agent.cwd, config.codexServer.command, ...config.attachmentRoots]) if (!path.isAbsolute(value)) throw Error("Directories and Codex binary must be absolute paths");
  mkdirSync(config.storageDir, { recursive: true, mode: 0o700 });
  const lock = path.join(config.storageDir, "relay.lock");
  // Exclusive ownership across MCP processes. A stale lock requires operator inspection.
  const fd = openSync(lock, "wx", 0o600); closeSync(fd);
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
  const server = new McpServer({ name: "awei-dedicated-session", version: "0.14.1" });
  const result = (value: unknown) => relayResult(value, config.storageDir);
  server.registerTool("awei_message", { description: "专用会话唯一入口。原样转交每条用户消息、语音转写及附件；同一消息重试沿用 receiptId。不要自行回答或创建 WorkBuddy 业务任务。", inputSchema: {
    receiptId: z.string().min(1).max(160), text: z.string().max(100000), voice: z.boolean().optional(), files: z.array(z.string()).max(10).optional(),
  } }, async ({ receiptId, ...input }) => result(jobs.submit(receiptId, input)));
  server.registerTool("awei_poll", { description: "查询转交结果。沿用回执和游标，按序原样回传文字；image/file 事件交给 WorkBuddy 原生附件发送。禁止将查询改成新提交。", inputSchema: {
    receiptId: z.string(), cursor: z.number().int().min(0).default(0),
  } }, async ({ receiptId, cursor }) => result(jobs.poll(receiptId, cursor)));
  server.registerTool("awei_status", { description: "检查专用阿维连接器及最近回执，不读取 WorkBuddy 会话。", inputSchema: {} }, async () => result({ version: "0.14.1", ...jobs.status() }));
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await core.close(); unlinkSync(lock); process.exit(0); };
  process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Startup failed"); process.exit(1); });
