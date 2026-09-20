import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync, appendFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import path from "node:path";
export const RELAY_VERSION = "0.16.0";
export interface Owner { v: 1; pid: number; startedAt: string; acquiredAt?: string; host: "awei-dedicated-session"; version: string; instanceId?: string; controlPort?: number; controlToken?: string }
export type Liveness = "dead" | "alive" | "alive-foreign" | "unknown" | "legacy-unknown";
export class LockError extends Error { exitCode = 2; }
export function processStart(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const s = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(s.slice(s.lastIndexOf(")") + 2).split(/\s+/)[19]);
      const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
      const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000 }));
      return Number.isFinite(boot + ticks / hz) ? (boot + ticks / hz) * 1000 : null;
    }
    const date = Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" } }).trim());
    return Number.isFinite(date) ? date : null;
  } catch { return null; }
}
export function parseOwner(raw: string): Owner | null {
  try {
    const d = JSON.parse(raw);
    return d.v === 1 && Number.isInteger(d.pid) && d.pid > 1 && d.host === "awei-dedicated-session" &&
      typeof d.version === "string" && typeof d.startedAt === "string" && Number.isFinite(Date.parse(d.startedAt)) ? d : null;
  } catch { return null; }
}
export function ownerLiveness(owner: Owner | null, deps = { kill: (pid: number) => process.kill(pid, 0), start: processStart }): Liveness {
  if (!owner) return "legacy-unknown";
  try { deps.kill(owner.pid); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "alive-foreign" : "unknown";
  }
  const start = deps.start(owner.pid);
  return start !== null && Math.abs(start - Date.parse(owner.startedAt)) <= 2000 ? "alive" : "unknown";
}
export function lockStatus(dir: string) {
  const file = path.join(dir, "relay.lock");
  if (!existsSync(file)) return { lock: null, liveness: null };
  const raw = readFileSync(file, "utf8"), owner = parseOwner(raw), state = ownerLiveness(owner);
  return { lock: owner ? { holderPid: owner.pid, acquiredAt: owner.acquiredAt ?? owner.startedAt, startedAt: owner.startedAt, version: owner.version,
    alive: state === "dead" ? false : state === "alive" || state === "alive-foreign" ? true : null } : { holderPid: null, acquiredAt: null, alive: null, version: null }, liveness: state };
}
export type ReleaseResult = { released: true } | { released: false; reason: "job-running" | "unknown"; detail: string };
export function audit(dir: string, event: string, fields: Record<string, unknown> = {}) {
  appendFileSync(path.join(dir, "diagnostics.log"), `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`, { mode: 0o600 });
}
/** Kernel-owned loopback listener serializes all filesystem transitions and vanishes on SIGKILL.
 * A hash collision fails closed. Nothing exposed beyond the local machine; release requires a random token.
 */
export class RelayLock {
  private server?: net.Server;
  private owner?: Owner;
  private releaseHandler?: (reason: string) => Promise<ReleaseResult>;
  private afterRelease?: () => void;
  private file: string;
  constructor(readonly dir: string) { this.file = path.join(dir, "relay.lock"); }
  private read() { if (!existsSync(this.file)) return null; const raw = readFileSync(this.file, "utf8"); return { raw, owner: parseOwner(raw) }; }
  private port() { return 40000 + createHash("sha256").update(realpathSync(this.dir)).digest().readUInt32BE(0) % 20000; }
  private async listen() {
    this.server = net.createServer(socket => {
      socket.setTimeout(15000, () => socket.destroy()); let input = "";
      socket.on("error", () => {});
      socket.on("data", chunk => {
        input += chunk.toString(); if (input.length > 4096) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        void (async () => {
          let response: ReleaseResult = { released: false, reason: "unknown", detail: "释放请求未获验证。" };
          try {
            const request = JSON.parse(input.trim()), token = this.owner?.controlToken;
            if (typeof request.token === "string" && token && request.token.length === token.length &&
              timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) && request.instanceId === this.owner?.instanceId && request.action === "release" && this.releaseHandler) {
              response = await this.releaseHandler(typeof request.reason === "string" ? request.reason.slice(0, 300) : "cli");
            }
          } catch { /* fail closed */ }
          socket.end(JSON.stringify(response) + "\n", () => { if (response.released) this.afterRelease?.(); });
          // The owner must still exit if the caller disconnected during cleanup.
          if (response.released) setTimeout(() => this.afterRelease?.(), 250).unref();
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", () => reject(new LockError("锁持有者或并发启动仍占用本地控制端口；请用 --lock-status 核对，再使用 --take-over。")));
      this.server!.listen({ host: "127.0.0.1", port: this.port(), exclusive: true }, resolve);
    });
  }
  private archive(snapshot: { raw: string; owner: Owner | null }) {
    if (this.read()?.raw !== snapshot.raw) throw new LockError("锁已变化，未回收；请重新检查。");
    renameSync(this.file, this.file + ".reclaimed-" + new Date().toISOString().replace(/:/g, "-") + "-" + randomUUID().slice(0, 8));
  }
  private async terminate(owner: Owner) {
    if (owner.pid === process.pid || ownerLiveness(owner) !== "alive") throw new LockError("无法核实 PID 身份，未发送信号。");
    audit(this.dir, "lock:takenover", { oldPid: owner.pid, action: "sigterm" });
    process.kill(owner.pid, "SIGTERM");
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (ownerLiveness(owner) === "dead") return;
      await new Promise(r => setTimeout(r, 50));
    }
    if (ownerLiveness(owner) !== "alive") throw new LockError("等待后 PID 身份无法确认，未强杀或回收。");
    audit(this.dir, "lock:takenover", { oldPid: owner.pid, action: "sigkill" }); process.kill(owner.pid, "SIGKILL");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { if (ownerLiveness(owner) === "dead") return; await new Promise(r => setTimeout(r, 50)); }
    throw new LockError("原进程尚未确认退出，未接管。");
  }
  async acquire(options: { takeOver?: boolean; force?: boolean; legacyActive?: () => boolean } = {}) {
    if (options.force && !options.takeOver) throw new LockError("--force 必须和 --take-over 同时使用。");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let before = this.read();
    if (before?.owner && ownerLiveness(before.owner) === "alive") {
      if (!options.takeOver || !options.force) throw new LockError(`锁由 PID ${before.owner.pid} 持有。正常交接请 awei_release / --release；显式中断需 --take-over --force。`);
      await this.terminate(before.owner);
    } else if (before?.owner && ["unknown", "alive-foreign"].includes(ownerLiveness(before.owner))) {
      throw new LockError(`PID ${before.owner.pid} 的身份或权限无法核实；--take-over 也不会杀死身份不明进程，请核对 owner。`);
    }
    try {
      await this.listen();
      const graceFile = path.join(this.dir, "relay.handover.json");
      if (!options.takeOver && existsSync(graceFile)) {
        let grace: { releasedAt: string; graceSeconds: number };
        try { grace = JSON.parse(readFileSync(graceFile, "utf8")); } catch { throw new LockError("交接记录损坏；核对后使用 --take-over。"); }
        if (!Number.isFinite(Date.parse(grace.releasedAt)) || !Number.isFinite(grace.graceSeconds)) throw new LockError("交接记录无效；核对后使用 --take-over。");
        if (Date.now() < Date.parse(grace.releasedAt) + grace.graceSeconds * 1000) throw new LockError("前一个桥刚主动释放，窗口留给新会话；如需立即接管用 --take-over。");
      }
      if (before?.owner && options.takeOver && options.force && !this.read()) {
        // A cooperative SIGTERM handler may already have removed its lock; retain the observed metadata.
        writeFileSync(this.file + ".reclaimed-" + new Date().toISOString().replace(/:/g, "-") + "-" + randomUUID().slice(0, 8), before.raw, { flag: "wx", mode: 0o600 });
      }
      // Re-read after obtaining the kernel gate; a contender may have changed ownership.
      const current = this.read();
      if (current) {
        const state = ownerLiveness(current.owner);
        if (state === "dead" || (state === "legacy-unknown" && options.takeOver && !options.legacyActive?.())) {
          this.archive(current);
          audit(this.dir, options.takeOver ? "lock:takenover" : "lock:reclaimed-stale", { oldPid: current.owner?.pid ?? null, action: "stale-reclaim" });
        } else throw new LockError(`锁状态 ${state}${current.owner ? `，PID ${current.owner.pid}` : "（旧版或无效锁）"}；未接管。请用 --lock-status 核对，旧版锁使用 --take-over；存活进程需显式 --force。`);
      }
      const start = processStart(process.pid);
      if (start === null) throw new LockError("无法读取本进程启动时间，未创建身份不可靠的锁。");
      this.owner = { v: 1, pid: process.pid, startedAt: new Date(start).toISOString(), acquiredAt: new Date().toISOString(), host: "awei-dedicated-session", version: RELAY_VERSION,
        instanceId: randomUUID(), controlPort: this.port(), controlToken: randomUUID() };
      const fd = openSync(this.file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(this.owner)); } finally { closeSync(fd); }
      if (options.takeOver && existsSync(graceFile)) renameSync(graceFile, graceFile + ".consumed-" + randomUUID().slice(0, 8));
      audit(this.dir, "lock:acquired", { pid: process.pid, version: RELAY_VERSION });
    } catch (error) { await this.closeGate(); throw error; }
  }
  onRelease(handler: (reason: string) => Promise<ReleaseResult>, afterResponse: () => void) { this.releaseHandler = handler; this.afterRelease = afterResponse; }
  owns() { return !!this.owner && this.read()?.owner?.instanceId === this.owner.instanceId; }
  release(reason: string, graceSeconds?: number) {
    if (!this.owns()) throw new LockError("锁已不属于本进程，未删除。");
    if (graceSeconds !== undefined) {
      const file = path.join(this.dir, "relay.handover.json");
      writeFileSync(file + ".tmp", JSON.stringify({ releasedAt: new Date().toISOString(), releasedBy: process.pid, graceSeconds }), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    }
    unlinkSync(this.file); audit(this.dir, "lock:released", { pid: process.pid, reason: reason.replace(/[\r\n]/g, " ").slice(0, 300) });
  }
  async closeGate() { const server = this.server; this.server = undefined; if (server?.listening) await new Promise<void>(r => server.close(() => r())); }
}
export async function requestRelease(dir: string): Promise<ReleaseResult> {
  const file = path.join(dir, "relay.lock");
  if (!existsSync(file)) return { released: false, reason: "unknown", detail: "没有可通信的持锁进程；--release 不会创建服务或修改回执。" };
  const owner = parseOwner(readFileSync(file, "utf8"));
  if (!owner || ownerLiveness(owner) !== "alive" || !Number.isInteger(owner.controlPort) || !owner.controlToken || !owner.instanceId)
    return { released: false, reason: "unknown", detail: "持有者不可验证或没有控制接口；已死 owner 可启动自愈，旧锁用 --take-over。" };
  return await new Promise(resolve => {
    let finished = false, data = "";
    const socket = net.connect({ host: "127.0.0.1", port: owner.controlPort! });
    const done = (value: ReleaseResult) => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
    const fail = () => done({ released: false, reason: "unknown", detail: "持有者未响应释放；未删锁或发送终止信号。" });
    socket.setTimeout(10000, fail); socket.on("error", fail); socket.on("end", () => { if (!finished) fail(); });
    socket.on("connect", () => socket.write(JSON.stringify({ action: "release", token: owner.controlToken, instanceId: owner.instanceId, reason: "cli" }) + "\n"));
    socket.on("data", chunk => { data += chunk.toString(); if (data.length > 8192) return fail(); if (data.includes("\n")) { try { done(JSON.parse(data)); } catch { fail(); } } });
  });
}
