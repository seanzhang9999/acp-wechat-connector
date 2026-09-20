# 给 Codex 的指令块：relay.lock 主动释放 + 显式接管

下方整块内容可直接粘贴到 Codex 会话。完整设计依据见 `docs/workbuddy-lock-handover-proposal.md`。

---

```text
任务：修复阿维 WorkBuddy 连接器（仓库根目录 = acp-wechat-connector）的 relay.lock 死锁问题，
实现「可主动释放 + 可显式接管 + 启动自愈」。基线 v0.14.1，目标 v0.15.0。

## 背景（必须理解，不要绕开）
bin/awei-workbuddy.ts 约 :20-22 用 openSync(lock, "wx", 0o600) 创建 0 字节锁，只在优雅退出
（SIGTERM/SIGINT/stdin end，约 :45-48）时 unlink。宿主强杀/重启/升级重拉进程会残留锁，此后任何
新实例都 EEXIST 启动失败，用户从微信侧无法自救。2026-09-20 已实际发生（PID 77151→78170，桥断约 5 分钟）。
要求：独占语义保持不变（同一时刻仍只允许一个桥），但锁必须可被 owner 主动释放、可被显式接管、
且在 owner 已死时自动回收。

## 实现顺序与行为（按此顺序落地）
1) 锁文件改为 JSON，仍用 openSync(..., "wx", 0o600) 保证创建的原子性，随后写入内容再 close：
   {"v":1,"pid":<number>,"startedAt":"<ISO>","host":"awei-dedicated-session","version":"0.15.0"}
   容错：文件为空或 JSON 非法 → 视为 legacy-unknown（v0.14.x 遗留），只允许显式接管，绝不自动回收。
   任何回收/接管都把旧锁重命名为 relay.lock.reclaimed-<ISO时间戳> 归档，不要删除。

2) 存活判定：
   - process.kill(pid, 0)：ESRCH = 已死；EPERM = 存活但非本用户。
   - PID 复用防护：用 startedAt 与进程真实启动时间（macOS: ps -o lstart= -p <pid>；Linux: /proc/<pid>/stat）
     比对，容差 ±2s。不一致或取不到 → 视为 unknown，只允许显式接管。
   - 原则：宁可多要一次确认，不可误抢活进程。

3) 启动自愈（默认行为，无需任何参数）：
   锁不存在 → 创建并写 JSON，日志 lock:acquired
   存在且 owner 已死 → 自动归档旧锁并继续启动，日志 lock:reclaimed-stale
   存在且 owner 存活 → 仍拒绝启动，stderr 明确写出「锁由 PID xxx 持有（startedAt=...）」并给 --take-over 指引
   存在且 legacy/unknown → 拒绝，提示使用 --take-over
   这一条是本次事故的根因修复，必须优先完成。

4) 主动释放（路径 A）：新增 MCP 工具 awei_release
   输入 { reason?: string }；输出 { released: true } | { released: false, reason: "job-running"|"unknown", detail: string }
   - 若存在 state === "running" 的回执（RelayJobs 增加 hasRunning()）→ 拒绝释放，返回 job-running（长任务由本进程
     持有连接，释放即切断）。
   - 否则：await core.close() → 写 relay.handover.json → 删除锁 → 先返回响应，再 process.exit(0)
     （延迟约 50ms 退出，避免宿主丢弃回包）。
   - 写日志 lock:released pid=<pid> reason=<reason>。
   relay.handover.json = {"releasedAt":"<ISO>","releasedBy":<pid>,"graceSeconds":180}
   grace 窗口内（默认 180s，可配 0 关闭）任何实例启动都拒绝并说明「前一个桥刚主动释放，窗口留给新会话；
   如需立即接管用 --take-over」。这解决「旧会话被宿主重新拉起后立刻抢回锁」的竞态。

5) 显式接管（路径 B）：新增 CLI 参数，供运维脚本或桥会话在用户明确确认后执行
   --lock-status         只读，打印锁内容与存活判定
   --release             不启动服务，执行与 A 相同的释放（无 running 回执时成功）
   --take-over           接管后继续启动服务：
                           owner 已死 → 回收归档 → 正常启动，退出码 0
                           owner 存活且无 --force → stderr 提示持有 PID，退出码 2
                           owner 存活且有 --force → SIGTERM，等待 ≤5s，仍在则 SIGKILL，回收后启动
   --force 每次执行写审计行 lock:takenover oldPid=<pid> action=sigterm|sigkill|stale-reclaim
   硬约束：~/.workbuddy/mcp.json 中不得默认带 --force。

6) 可观测性：
   awei_status 返回值增加 lock 字段：{ holderPid, acquiredAt, alive, version } | null。
   diagnostics.log 事件名固定为这四个，不要改名：lock:acquired / lock:released / lock:reclaimed-stale / lock:takenover

7) 配套文档与版本：
   connectors/workbuddy/skills/awei-session/SKILL.md 第 7 条改为：用户要求「停止桥接模式」时先调用
   awei_release；released:true → 退出桥接模式并说明未释放 Codex 业务会话；返回 job-running → 如实告知仍有
   任务在跑并询问是否等待；工具不可用（桥已断）→ 保留现有「提示用户断开连接器」话术。
   CHANGELOG.md 增加 0.15.0 条目；bin/awei-workbuddy.ts 中两处版本字符串同步为 0.15.0
   （约 :36 与 :44，以实际 grep 结果为准）。
   docs/workbuddy-integration-proposal.md 同步「停止桥接模式」「换会话接管」两节。

## 非目标（不要做）
- 不放开多实例并发：一个桥一个会话是产品约束。
- 不改 WorkBuddy 宿主侧的进程生命周期或连接器管理粒度。
- 除显式 --force 外，绝不自动终止存活进程。
- 不删除任何锁文件，一律改名归档。

## 测试（沿用现有 tests 风格，用子进程模拟强杀）
1. 锁 JSON 写入/读取往返；空文件与非 JSON 文件判为 legacy-unknown。
2. 子进程启动后 SIGKILL → 新进程启动自愈成功，旧锁被归档为 relay.lock.reclaimed-*。
3. owner 存活时新进程启动失败，错误信息含持有 PID 与 --take-over 指引。
4. --take-over 无 --force 退出码 2；带 --force 后旧进程终止、新进程接锁、审计行存在。
5. awei_release 在有 running 回执时返回 job-running 且不删锁；无 running 回执时成功删锁并写 relay.handover.json。
6. grace 窗口内新实例拒绝启动；窗口过期后正常启动。
7. 回归：回执幂等、游标分页、重启后 running → unknown 的行为保持不变。

## 验收标准（逐条自检并报告结果）
- npm run build 通过，无 TS 报错。
- 全部新增测试 + 既有测试通过。
- 手工验证：① 启动实例 A，kill -9 → 立刻启动实例 B，B 成功（自愈）并留下 reclaimed 归档 + lock:reclaimed-stale 日志。
          ② 实例 A 存活时启动 B → B 拒绝，stderr 含 PID 与 --take-over 指引。
          ③ 实例 A 存活时 --take-over 无 --force → 退出码 2；带 --force → A 被终止，B 接锁，审计行写入。
          ④ awei_release 在有 running 回执时被拒绝；清空回执后可释放，且 180s 内新实例拒绝启动。
- awei_status 返回中的 lock 字段能正确反映「锁被谁持有、是否存活」。
- 交付一份简短实现说明：改了哪些文件、与提案是否有偏差、遗留风险。
```


实施记录：v0.15.0 实现见 [当前使用与交接说明](workbuddy-integration-proposal.md)。本文保留原始需求；实际 --release 通过持锁进程的控制接口执行，成功会关闭本桥的 Codex 连接并保留历史。PID 身份不匹配时即使 --force 也不会杀进程。
