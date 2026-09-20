# 改造建议：relay.lock 的主动释放与显式接管

版本基线：v0.14.1 · 目标版本：v0.15.0
适用文件：`bin/awei-workbuddy.ts`（锁与生命周期）、`src/workbuddy/jobs.ts`（回执状态）、`connectors/workbuddy/skills/awei-session/SKILL.md`（停止桥接模式流程）

## 一、问题与证据

现状（`bin/awei-workbuddy.ts:20-22`）：

```ts
const lock = path.join(config.storageDir, "relay.lock");
// Exclusive ownership across MCP processes. A stale lock requires operator inspection.
const fd = openSync(lock, "wx", 0o600); closeSync(fd);
```

释放只发生在优雅退出路径（`:45-48`，SIGTERM / SIGINT / stdin end）。由此产生三个后果：

1. **锁文件 0 字节**：不记录 PID、启动时间、版本，谁都无法判断持有者是否还活着。
2. **宿主强杀即留死锁**：宿主重启或升级 MCP 时进程被强杀，锁残留；此后**任何**新实例一律 `EEXIST` 启动失败。实测 stderr：`EEXIST: file already exists, open '.../state/relay.lock'`。
3. **无自愈**：注释把"陈旧锁需要人工检查"当作设计，但实际结果是"重连也没用"，只能人工改名，且用户从微信侧完全无法自救。

已发生的真实故障（2026-09-20）：连接器升级到 v0.14.1 时宿主重拉进程（PID 77151 → 78170），旧进程被强杀留下 0 字节锁，新进程与后续所有重连全部启动失败，桥中断约 5 分钟。

## 二、决策：两条路径都保留，但触发条件不同

回答"该走哪个"：**都要，且不是二选一**。它们覆盖互斥的两类场景：

| 场景 | owner 状态 | 正确路径 | 理由 |
| --- | --- | --- | --- |
| 用户主动停止桥接 / 换会话接管 | 存活且可通信 | **A 主动释放** | 干净、无损，不需要猜测和杀进程 |
| 宿主强杀、崩溃、升级残留 | 已死 | **启动自愈**（B 的自动子集） | 无人可通信，回收是确定性安全的 |
| owner 假死 / 不受控 / 无法通信 | 存活但无响应 | **B 显式接管（需 --force）** | 有风险，必须显式且留审计 |
| 正常换会话，旧会话仍在跑长任务 | 存活且忙 | **都不走** | 切断会丢任务；应让用户先等结果 |

单独走 A 不够：宿主在旧会话仍开着连接器时可能重新拉起进程抢回锁，释放后没有窗口保证。
单独走 B 不够：正常的换会话场景不该对着活进程动手。
因此实现顺序为 **启动自愈 → A → B（显式）**，且锁的独占语义不变：同一时刻仍然只允许一个桥。

## 三、锁文件格式

改为 JSON（仍是 `openSync(lock, "wx", 0o600)` 保证创建原子性，随后写入内容再 close）：

```json
{"v":1,"pid":78170,"startedAt":"2026-09-20T08:10:00.000Z","host":"awei-dedicated-session","version":"0.15.0"}
```

读取容错：

- 文件为空或 JSON 非法 → 视为 `legacy-unknown`（v0.14.x 遗留），**只允许显式接管**，不自动回收，避免误判活进程。
- 接管或回收时，旧锁重命名为 `relay.lock.reclaimed-<ISO时间戳>` 保留审计，不直接删除。

## 四、存活判定

- `process.kill(pid, 0)`：抛 `ESRCH` → 已死；抛 `EPERM` → 存活但非本用户。
- PID 复用防护：`startedAt` 与 `ps -o lstart= -p <pid>`（macOS）或 `/proc/<pid>/stat` 的启动时间做容差比对（±2s）；不一致或取不到（沙箱）→ 视为 `unknown`，**只允许显式接管**。宁可多要一次确认，不可误抢活进程。

## 五、路径 A：主动释放（MCP 工具）

新增工具 `awei_release`：

```
输入：{ reason?: string }
输出：{ released: true } | { released: false, reason: "job-running" | "unknown", detail: string }
```

行为：

1. 若存在 `state === "running"` 的回执（`RelayJobs` 需新增 `hasRunning()`）→ **拒绝释放**，返回 `job-running`。理由：长任务由本进程持有连接，释放即切断。
2. 否则 `await core.close()` → 写 `relay.handover.json`（见下）→ 删除锁 → **先返回响应，再退出**（延迟约 50ms 调 `process.exit(0)`），避免宿主丢弃回包。
3. 全过程写 `diagnostics.log`：`lock:released pid=<pid> reason=<reason>`。

`relay.handover.json`：

```json
{"releasedAt":"2026-09-20T08:20:00.000Z","releasedBy":78170,"graceSeconds":180}
```

grace 窗口内（默认 180s，可配 0 关闭），**任何**实例启动时看到该文件即拒绝启动并说明"前一个桥刚主动释放，窗口留给新会话；如需立即接管用 `--take-over`"。这解决"旧会话被宿主重新拉起、立刻抢回锁"的竞态。

配套修改 `awei-session/SKILL.md` 第 7 条：用户要求"停止桥接模式"时，先调用 `awei_release`；成功（`released:true`）再退出桥接模式并说明未释放 Codex 会话；返回 `job-running` 时如实告知还有任务在跑、询问是否等待；工具不可用（桥已断）时保留现有"提示用户断开连接器"的话术。

## 六、路径 B：显式接管（外带 CLI，需审计）

新增 CLI 参数，供运维脚本或桥会话在获得用户确认后执行：

- `--lock-status`：打印锁内容与存活判定，只读。
- `--release`：不启动服务，执行一次与 A 相同的释放（无 running 回执时成功）。
- `--take-over`：接管后**继续启动服务**。
  - owner 已死 → 回收（归档旧锁）→ 正常启动，退出码 0。
  - owner 存活 → 无 `--force`：stderr 明确提示"锁由 PID xxx 持有"并退出码 2；带 `--force`：`SIGTERM` owner，等待 ≤5s，仍在则 `SIGKILL`，然后回收启动。
  - 每次接管写一行审计到 `diagnostics.log`：`lock:takenover oldPid=<pid> action=sigterm|sigkill|stale-reclaim`。

**约束**：`~/.workbuddy/mcp.json` 中**不得**默认带 `--force`，强制接管必须由用户或桥会话在明确确认后单独执行——`--force` 会切断旧会话正在运行的任务。

## 七、启动自愈（默认行为）

主流程改为：

```
读取锁 →
  不存在            → 正常创建（写 JSON），日志 lock:acquired
  存在 & owner 已死 → 自动回收（归档旧锁）并继续启动，日志 lock:reclaimed-stale
  存在 & owner 存活 → 保持拒绝，stderr 给出可操作提示与 --take-over 指引
  存在 & legacy/unknown → 拒绝，提示使用 --take-over
```

这一条直接消灭"升级/强杀后再也起不来"，也是本次事故的根因修复。

## 八、可观测性

- `awei_status` 返回增加 `lock: { holderPid, acquiredAt, alive, version } | null`，桥会话可一句话回答"锁被谁占着、是否还活着"。
- `diagnostics.log` 事件名固定：`lock:acquired` / `lock:released` / `lock:reclaimed-stale` / `lock:takenover`。

## 九、测试

新增（沿用现有 tests 风格，子进程模拟强杀）：

1. 锁 JSON 写入/读取往返；空文件与非 JSON 文件判为 `legacy-unknown`。
2. 子进程启动后 `SIGKILL` → 新进程启动自愈成功，旧锁被归档。
3. owner 存活 → 新进程启动失败，错误信息含持有 PID 与 `--take-over` 指引。
4. `--take-over` 无 `--force` 退出码 2；带 `--force` 后旧进程终止、新进程接锁、审计行存在。
5. `awei_release` 存在 running 回执时返回 `job-running` 且**不**删锁；无 running 回执时成功删除并写入 `relay.handover.json`。
6. grace 窗口内新实例拒绝启动；窗口过期后正常启动。
7. 回归：回执幂等、游标分页、重启后 running→unknown 的行为不变。

## 十、版本与兼容

- 版本 0.15.0，`CHANGELOG.md` 增加条目；`bin/awei-workbuddy.ts:36` 与 `:44` 的版本字符串同步。
- 旧 0 字节锁**不自动回收**，一次性迁移使用 `--take-over`；此后所有锁都带元数据，自愈生效。
- `docs/workbuddy-integration-proposal.md` 与 `awei-session/SKILL.md` 同步更新"停止桥接模式"与"换会话接管"两节。

## 十一、非目标

- 不做多实例并发：一个桥一个会话是产品约束，本次改造不放开。
- 不改 WorkBuddy 宿主侧的进程生命周期与连接器管理粒度。
- 不自动终止存活进程：除显式 `--force` 外，绝不杀活进程。


实施记录：v0.15.0 实现见 [当前使用与交接说明](workbuddy-integration-proposal.md)。本文保留原始需求；实际 --release 通过持锁进程的控制接口执行，成功会关闭本桥的 Codex 连接并保留历史。PID 身份不匹配时即使 --force 也不会杀进程。
