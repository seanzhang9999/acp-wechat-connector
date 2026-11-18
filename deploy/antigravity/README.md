# Antigravity 阶段 A 验证包

状态：代码与模板准备，尚未部署。阶段 A 通过前不启动微信或 DeepSeek。
本目录的 unit 是一次性诊断服务，不是已完成的常驻微信助手。

## 来源、版本与账号

2026-11-18 复核官方资料：
- https://antigravity.google/docs/cli/acp ：`agy acp`、`agy acp --help`，交互 `agy` 或 `agy acp --login`，复用 CLI 凭据。
- https://antigravity.google/docs/install?tab=cli ：登录与本机密钥环，Linux Secret Service/dbus。
- https://antigravity.google/docs/models ：实际权限须现场确认，不能硬编码网页中的模型名。
- https://antigravity.google/docs/getting-started?tab=cli ：安装入口。下载前检查当前官方链接、平台/架构与签名/校验信息；不要执行第三方安装脚本。

目标主机由 Sean 指定。不得沿用历史 IP、用户名或凭据。先记录发行版、CPU、内存、磁盘、Node >=20 路径、网络可达性；建立专用非 root 用户及独立空工作目录。安装官方 CLI 后记录安装 URL、版本、校验依据、`agy --version` 与 `agy acp --help`。用同一服务 UID 由 Sean 完成本人登录；授权码只进官方 CLI，不录屏或重定向到日志。禁止借助 API 付费后备路径绕过订阅权限。

## 构建与发现

在隔离 checkout 中 `npm ci && npm run build`。探测器不提供客户端文件/终端能力，拒绝权限请求，遇到工具调用取消并判失败。但这不是 OS 沙箱：官方 Agent 自带工具必须依靠其自身权限设置及专用 UID 隔离。不要把秘密或真实业务文件放入 probe-workspace。

以运行用户设置 AGY_BIN（已核验的绝对路径）和 AGY_PROBE_CWD（独立空目录），运行：

```sh
node dist/bin/antigravity-probe.js
```

未设置 AGY_MODEL_ID 时仅 initialize/session/new，返回服务端公布的 model ID；不会发送 prompt，不代表模型调用通过。若服务端未提供模型列表或兼容选择接口，停止并记录差异，不猜 model ID、不降级到默认模型。

从返回值中核实 Opus 对应 ID，再显式设置 AGY_MODEL_ID 并重新运行同一命令。最多一次固定文本请求，期待 `ACP_PROBE_OK`。输出记录时间、model ID、选择依据、是否正常完成；不输出登录信息、原始错误或任意模型内容。config selector 使用回包确认；旧 models 接口使用成功 setter 回执，此证据不等于第三方模型底层独立审计。模型名来自协议，不采信模型自称。错误不自动重试，额度不足不自动切换。

## 后台凭据矩阵

复制 probe.env.example 到 `/etc/awei-antigravity/probe.env`（0600）并填写实际路径。安装模板前人工校对 unit 的 UID/GID、Node 和 checkout 路径。为该 UID 准备 HOME、用户配置目录、dbus 与 Secret Service；不拷贝 token、不自行实现刷新。不因打开 linger 或复制 HOME 就标记后台授权完成。

| 步骤 | 要保留的证据 | 当前状态 |
|---|---|---|
| 交互 SSH 登录后的指定 Opus 调用 | CLI 来源/版本、协议 model ID、一次成功 receipt | 未验证 |
| systemd 单次调用 | 同一 UID、unit 配置、成功 receipt | 未验证 |
| 脱离 SSH | 启动 oneshot 后断开 SSH，稍后重连读取 journal；记录断开与完成时间，若调用过快则安排一次延迟执行 | 未验证 |
| 再次启动服务 | 新进程的成功 receipt，无需人工解锁 | 未验证 |
| 主机重启 | 先获维护窗口，再核验 boot ID、密钥环解锁方式、重新运行 receipt | 未验证 |
| 后续调用/72 小时 | 开始结束时间、真实调用、异常与恢复 | 未验证 |

unit 不自动安装、不 enable、不设置 timer、不循环调用。用 `systemctl start --no-block awei-antigravity-probe` 发起单次测试；以 `systemctl status` 和 `journalctl -u awei-antigravity-probe` 读回。每个步骤独立记录，不以本机或 mock 通过代替云端通过。首次登录和权限问题在交互 CLI 内诊断，诊断文字脱敏后再写事项。

## 原代码审计与后续门槛

基线 fed2e35，无仓库 AGENTS.md；原工作区干净。
- src/acp/client.ts requestPermission 自动选 allow_once/allow_always，且读写文件直接使用传入路径。阶段 A 故意不复用此客户端。
- src/awei/model.ts 强制 read-only；保持其保护，不为兼容 Antigravity 删除。
- src/awei/controller.ts 与 bridge.ts 绑定 CodexRouter；后续需抽象 provider/task 接口。
- 已有消息发送重试不能替代 SQLite 入站去重、任务落盘和出站队列。

A 真实通过后才实施 B：独立 iLink 配对、单轮询 owner、任务锁、绑定用户/request/task/期限的单次审批、取消与重启恢复、附件边界。B 通过后实施 C：DeepSeek LanguageService 与 schema 校验；Key 由服务凭据提供，不搜索用户秘密。D 再开始真实 72 小时观察。上述 B/C/D 未在本次实现。

## 升级、回滚与故障

记录代码 commit、lockfile、Node/CLI 版本，先在隔离目录构建测试；升级官方 CLI 前保存可回退的安装版本信息。不要覆盖 Mac 现有实例、state.json 或微信登录态。

本阶段失败时停止 probe unit，保留脱敏 receipt；不启动后续服务。切回此前代码 checkout/官方 CLI 版本后重新做 A 验证；不删除账号凭据、会话或成果。授权失败返回交互登录；断网/超时/结果不明不得自动重发业务任务。以后 B/C 的 unknown 状态和恢复策略仍待实现。

## 实际 agy 用量计量（2026-11-18 增补）

设置 `AGY_USAGE_DIR=/var/lib/awei-antigravity/usage`，计量目录位于 Agent 工作目录之外。
每次探测创建唯一持久记录；提交 prompt 前先写入标记，结束后原子更新。中途退出留下 unknown，不能算零消耗或自动补跑。仅记录模型 ID、时间、结果、已提交 prompt 数和服务端用量字段，不存 prompt、模型正文或凭据。

```sh
AGY_USAGE_DIR=/var/lib/awei-antigravity/usage node dist/bin/antigravity-usage.js
```

统计边界：
- 一次 ACP prompt 是一次逻辑调用，内部可能多次请求 LLM，不能称作一次底层推理；内部次数未上报则为 null。
- 本探测器每次新会话且只发一次 prompt，可对这些独立会话的 provider token 回包求和；以后业务恢复会话须先确认 provider 的累计/增量语义再接入，禁止重复累计。
- token 字段分别保留 input/output/total/cache read/cache write/thought；不把可能重叠的字段相加生成总量。缺失不是 0。
- usage_update.used/size 是上下文占用；cost 是会话累计成本（若上报）；两者都不是订阅余量。cost 不按 Anthropic API 标价推算订阅消耗。
- DeepSeek 的调用单独计量，此记录只覆盖本执行入口。Mac/IDE/其他 CLI 对同一账号的消耗不在本地调用账内。
- 官方 `/usage`（`/quota`）面板提供模型组的周额度与五小时额度；Claude/GPT 共享组，不等于 Opus 专属额度。当前未找到已验证的非交互额度导出接口，不提取 token 或调用私有刷新协议。

余量测算：先记录官方同一额度窗口的前后百分比、刷新/重置时间、本地调用数和任务类别；只在无其他客户端消耗、没有窗口重置且下降可辨认时算每类任务平均百分点消耗。`可再做任务数 ≈ 剩余百分点 / 同类任务平均百分点消耗`，分别计算周/五小时窗口取较小值。应给区间并展示样本数；样本不足、百分比舍入不变、跨窗口或账号并发使用时不报告确定次数。不为校准刷无意义请求；随真实任务积累样本。当前真实业务样本尚不足。
