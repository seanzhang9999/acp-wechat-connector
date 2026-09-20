import type { RelayLock, ReleaseResult } from "./lock.js";
import { audit } from "./lock.js";
export class RelayLifecycle {
  private state: "open" | "closing" | "closed" = "open";
  constructor(private lock: RelayLock, private jobs: { hasRunning(): boolean }, private core: { close(): Promise<void>; assertReleasable?(): Promise<void> }, private graceSeconds = 180) {}
  accepting() { return this.state === "open"; }
  async release(reason = "user"): Promise<ReleaseResult> {
    if (this.state !== "open") return { released: false, reason: "unknown", detail: "释放已经开始或连接已关闭。" };
    if (this.jobs.hasRunning()) return { released: false, reason: "job-running", detail: "还有任务运行；未关闭连接或释放锁，请等待结果。" };
    this.state = "closing"; // Stop admission before the first await.
    try { await this.core.assertReleasable?.(); }
    catch { this.state = "open"; return { released: false, reason: "unknown", detail: "业务会话仍有审批、任务或状态不确定；未释放，请先核对。" }; }
    try {
      await this.core.close();
      this.lock.release(reason, this.graceSeconds); this.state = "closed";
      return { released: true };
    } catch {
      audit(this.lock.dir, "lock:release-failed", { pid: process.pid });
      return { released: false, reason: "unknown", detail: "清理未完成，锁保留且已停止接收新任务；请核对进程状态。" };
    }
  }
  async shutdown() {
    if (this.state === "closed") return;
    if (this.state === "closing") return;
    this.state = "closing";
    await this.core.close();
    if (this.lock.owns()) this.lock.release("host-shutdown");
    this.state = "closed";
  }
}
