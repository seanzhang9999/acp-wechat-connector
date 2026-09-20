#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RelayLock, lockStatus, requestRelease, LockError, RELAY_VERSION, type ClaimResult } from "../src/workbuddy/lock.js";
import { RelayLifecycle } from "../src/workbuddy/lifecycle.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DedicatedCore } from "../src/workbuddy/core.js";
import { relayResult } from "../src/workbuddy/results.js";
import { RelayJobs } from "../src/workbuddy/jobs.js";
import { issueTransfer, checkTransfer, consumeTransfer } from "../src/workbuddy/transfer.js";
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
  const legacyActive = () => {
    // Old zero-byte locks have no identity. Never reclaim if a matching legacy launch is still present.
    try {
      const rows = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 2000 });
      return rows.split("\n").some(line => { const m = line.trim().match(/^(\d+)\s+(.+)$/); return !!m && Number(m[1]) !== process.pid && /awei-workbuddy\.(?:js|ts)/.test(m[2]) && m[2].includes(file); });
    } catch { return true; }
  };
  const lock = new RelayLock(config.storageDir);
  // Plain startup never fails on lease contention: without a live owner this process claims the bridge,
  // otherwise it stays as a standby server with all tools registered. Business resources stay uninitialized
  // until ownership is held, so standbys never open Codex/ACP connections or rewrite relay receipts.
  // Explicit --take-over keeps the old strict semantics: acquire or exit 2.
  const initial: ClaimResult = flags.has("--take-over")
    ? (await lock.acquire({ takeOver: true, force: flags.has("--force"), legacyActive }), { kind: "owner" })
    : await lock.claim({ bypassGrace: true, legacyActive });
  // Protocol uses stdout exclusively, including logs from shared components.
  console.log = (...args: unknown[]) => console.error(...args);
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    // userError has already redacted these lines. Keep a durable error-ID lookup even if the host discards stderr.
    const line = args.length === 1 && typeof args[0] === "string" ? args[0] : "";
    if (line.startsWith("[bridge-error ")) {
      try { appendFileSync(path.join(config.storageDir, "diagnostics.log"), new Date().toISOString() + " " + line + "\n", { mode: 0o600 }); } catch { /* stderr remains available */ }
    }
    originalWarn(...args);
  };
  let owned = initial.kind === "owner";
  let core: DedicatedCore | undefined, jobs: RelayJobs | undefined, lifecycle: RelayLifecycle | undefined;
  let stopping = false;
  const exitAfterResponse = () => { if (!stopping) { stopping = true; setTimeout(() => process.exit(0), 50); } };
  const initOwner = () => {
    if (jobs && lifecycle) return;
    core = new DedicatedCore(config);
    jobs = new RelayJobs(config.storageDir, (input, emit) => core!.run(input, emit));
    lifecycle = new RelayLifecycle(lock, jobs, core, config.handoverGraceSeconds);
    lock.onRelease(reason => lifecycle!.release(reason), exitAfterResponse);
  };
  const becomeOwner = async (): Promise<ClaimResult> => {
    if (owned) return { kind: "owner" };
    const attempt = await lock.claim({ bypassGrace: true, legacyActive });
    if (attempt.kind === "owner") { owned = true; initOwner(); }
    return attempt;
  };
  if (owned) initOwner(); // startup already claimed a free lease
  const server = new McpServer({ name: "awei-dedicated-session", version: RELAY_VERSION });
  const result = (value: unknown) => relayResult(value, config.storageDir);
  const standbyError = (claim: ClaimResult) => new Error(`本会话未持有写权限，未执行。${claim.kind === "standby" ? claim.detail : ""} 持有会话可生成转移码（awei_transfer）后，在这里用 awei_acquire 凭码接管；或等其释放（awei_release / 停止桥接模式）后重发本条，沿用同一 receiptId。`);
  server.registerTool("awei_message", { description: "专用会话唯一入口。原样转交每条用户消息、语音转写及附件；同一消息重试沿用 receiptId。空闲时自动取得写权限；被其他会话持有时会拒绝并说明接管方式。不要自行回答或创建 WorkBuddy 业务任务。", inputSchema: {
    receiptId: z.string().min(1).max(160), text: z.string().max(100000), voice: z.boolean().optional(), files: z.array(z.string()).max(10).optional(),
  } }, async ({ receiptId, ...input }) => {
    if (lifecycle && !lifecycle.accepting()) throw Error("正在释放桥接，未接收新消息。");
    const claim = await becomeOwner();
    if (claim.kind !== "owner") throw standbyError(claim);
    return result(jobs!.submit(receiptId, input));
  });
  server.registerTool("awei_poll", { description: "查询转交结果。沿用回执和游标，按序原样回传文字；image/file 事件交给 WorkBuddy 原生附件发送。禁止将查询改成新提交。", inputSchema: {
    receiptId: z.string(), cursor: z.number().int().min(0).default(0),
  } }, async ({ receiptId, cursor }) => {
    if (!jobs) throw Error(`本会话没有本地回执可查${owned ? "" : "（写权限由其他会话持有）"}；receiptId 只在提交它的会话进程里有效。`);
    return result(jobs.poll(receiptId, cursor));
  });
  server.registerTool("awei_status", { description: "检查专用阿维连接器、写权限归属及最近回执，不读取 WorkBuddy 会话。", inputSchema: {} }, async () => result({
    version: RELAY_VERSION, mode: owned ? "owner" : "standby",
    ...(jobs ? jobs.status() : { active: false, receipts: [] }),
    ...lockStatus(config.storageDir),
    ...(owned ? {} : { standby: { detail: initial.kind === "standby" ? initial.detail : "未持有写权限。" } }),
  }));
  server.registerTool("awei_release", { description: "用户主动停止专用桥或换会话时调用。忙碌拒绝；成功关闭本桥连接、保留历史并留出交接窗口。未持有写权限时无需调用。", inputSchema: { reason: z.string().max(300).optional() } }, async ({ reason }) => {
    if (!owned || !lifecycle) return result({ released: false, reason: "unknown", detail: "本会话未持有写权限，无需释放。" });
    return result(await lifecycle.release(reason));
  });
  server.registerTool("awei_transfer", { description: "持有写权限的会话生成一次性转移码（10 分钟有效），供另一会话凭码接管写权限；不中断当前持有。", inputSchema: {} }, async () => {
    if (!owned) throw Error("只有持有写权限的会话可以生成转移码。");
    if (jobs?.hasRunning()) throw Error("还有任务运行；等当前结果完成后再生成转移码。");
    const ticket = issueTransfer(config.storageDir, "owner");
    return result({ issued: true, code: ticket.code, expiresAt: ticket.expiresAt, note: `转移码 ${ticket.code}，10 分钟内有效、仅可使用一次。到目标会话发送：桥：接管 ${ticket.code}（即调用 awei_acquire 并传入该码）。` });
  });
  server.registerTool("awei_acquire", { description: "接管写权限：无人持有时直接取得；被持有时必须提供持有会话签发的一次性转移码，验证后请对方释放并接管。", inputSchema: { code: z.string().min(6).max(16).optional() } }, async ({ code }) => {
    if (owned) return result({ acquired: true, note: "本会话已是写权限持有者。" });
    const status = lockStatus(config.storageDir);
    if (status.liveness === "alive" || status.liveness === "unknown" || status.liveness === "alive-foreign") {
      if (!code) throw Error("写权限正被其他会话持有；需要一次性转移码。让持有会话执行 awei_transfer 后，凭码重试。");
      const checked = checkTransfer(config.storageDir, code);
      if (!checked.ok) throw Error(checked.detail);
      const released = await requestRelease(config.storageDir);
      if (!released.released) throw Error(`持有会话未能释放（${"detail" in released ? released.detail : "原因未知"}）；转移码未消耗，可修正后重试。`);
      consumeTransfer(config.storageDir);
    }
    const claim = await becomeOwner();
    if (claim.kind !== "owner") throw standbyError(claim);
    return result({ acquired: true, note: "本会话已取得写权限；历史回执保留在存储目录，原会话进程即将退出或转待命。" });
  });
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    try { if (lifecycle) await lifecycle.shutdown(); await lock.closeGate(); process.exit(0); }
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
  if (!owned) console.error(`[awei] standby: ${initial.kind === "standby" ? initial.detail : "未持有写权限"}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Startup failed"); process.exit(error instanceof LockError ? 2 : 1); });
