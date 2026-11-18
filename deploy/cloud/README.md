# 独立微信 → DeepSeek → ACP/Opus 服务

这是独立 `awei-cloud` 入口；保留旧 Mac Codex/WorkBuddy 路径。Linux Node 22.23.5（node:sqlite）、systemd。

## 运行与权限

- `awei-wechat`：iLink、DeepSeek、SQLite、outbox、计量；HOME/state 0700。
- `awei-antigravity`：既有官方 Google 登录；通过私有 systemd socket 启动 `agy acp --sandbox --disable-telemetry`。不继承 DeepSeek Key 或微信 token。
- 共享 `awei-work` 组只访问 `/var/lib/awei-workspaces`；每任务独立随机目录。父目录3770，文件不进入凭据目录。
- ACP 明确选择官方 `default`（Ask before edits and commands）模式。沿用官方已有权限规则，未启用 dangerously-skip-permissions。客户端不提供文件/终端接口。
- 权限请求仅允许 allow_once，绑定配对用户、task、随机request ID和两分钟有效期；重启失效。DeepSeek 无 approve 动作。超长参数拒绝，防止审批只显示不完整摘要。
- 这不是跨租户安全沙箱；单用户环境。Google 登录凭据仍由官方执行用户管理，不能承诺模型绝对无法访问该 UID 下的所有文件。

## 用户配置

Windows PowerShell 可运行：

```powershell
ssh -t ubuntu@aihunt.duckdns.org "sudo /usr/local/sbin/awei-setup-deepseek"
ssh -t ubuntu@aihunt.duckdns.org "sudo /usr/local/sbin/awei-wechat-login"
```

第一条隐藏输入 Key，只调用官方 `/models` 验证并打印实际模型 ID，用户选序号后保存到 root-only 配置。不要把 Key 发给助手或写到聊天。systemd LoadCredential 在服务启动时交给路由进程；执行器另一个 UID 不接收该凭据。配置工具不自动重启服务。

第二条在终端显示微信二维码；仅登录到云端独立存储，不打印 token，不启动轮询。若该微信账号在旧桥接使用同一 iLink 身份，扫码可能替换旧登录；不同时运行两个相同身份的轮询 owner。服务 `flock` 防止本目录重复 owner，但不能替另一台机器加锁。上线前核对配对身份并停用冲突 owner。

有 token 后才可启动 `awei-wechat.service`。未配置 DeepSeek 时仅确定性命令可用，自然语言明确提示缺配置；不会悄悄使用其他付费模型。切换 DeepSeek 配置需重启服务（先等待任务空闲）。

## 任务使用

- `/new 用户原话`：创建任务并执行；没有静默队列，忙时明确拒绝，避免目标漂移。
- `/continue 任务ID 新要求`：必须恢复原 session；不支持恢复就停止，绝不偷偷新建。unknown 必须以 `确认继续：` 开头，新要求不自动重放旧 prompt。
- `/list`、`/status 任务ID`、`/cancel 任务ID`、`/usage [任务ID]`。
- `/approve 请求ID`、`/deny 请求ID`：本人明确一次性审批；自然语言不代批准。
- `/files 任务ID`、`/file 任务ID 文件名`：任务文件只允许 realpath 边界内、非符号链接目标、最大10MiB。入站文件/图片也限10MiB，生成随机安全文件名；不支持的附件明确拒绝。语音仅使用 iLink 提供的转写文字，没有自行 ASR。
- `/model 模型ID`：用户精确命令设置后续新任务模型；实际执行再核对服务端列表，失败不回退。DeepSeek 不能自行切模型。
- 自然语言经 DeepSeek JSON schema 选择 new/continue/list/status/cancel/usage/clarify。用户原话保留，执行请求不由 DeepSeek 重写。结果回微信标 `[Opus 原文]`；完整原文存 SQLite 与任务文件，微信展示限12k字符。首版未做 DeepSeek 结果摘要。

## 持久性与统计

SQLite WAL + synchronous FULL：每批消息与 cursor 同一事务落盘，再处理；sender 必须为扫码返回的本人，拒绝群消息/缺少稳定ID的消息。
原始请求、task/model/session/cwd/status、每轮结果和实际 usage 分开保存。出站独立队列、稳定 client_id、限次退避；发送失败不重跑任务。文件先上传、保存 media 描述，再发送，重试复用描述。
服务崩溃后 running/waiting_approval/queued 变 unknown，待审批失效；不自动执行不确定任务。发送失败8次后 delivery_failed，可从服务器检查；首版没有自动过期消息重建context的承诺。exactly-once 无保证。

用量在执行器实际 prompt 之前记录开始、完成后记录 provider token；按task/turn关联。新会话单轮可求和，恢复会话字段保留但标 `resumed_session_unverified`，在未确认提供方累计语义前不重复求和。官方订阅余量仍是单独的官方面板快照，不由token推算。DeepSeek只路由，不混入Opus计量。

## 验收和回滚

先构建并测试，再测试私有socket实际调用、权限拒绝、取消、会话恢复和计量；再本人扫码。先直接 `/new` 验证微信往返，之后配置Key验证自然语言路由。同账号旧poll owner须排除。所有实机证据写事项，不把mock通过标成微信可用。

升级保留版本目录，用 cloud-current 软链接切版本；空闲时停服务、切链接、启动。任务运行中先等待或经用户要求取消，不盲重启。回滚同理，SQLite/凭据/成果保留。停止微信服务不删除登录态；不要关闭既有代理、Codex或监控服务。systemd socket私有不开放公网端口。72小时观察必须单独开始并记录。

## Windows 终端二维码显示不清

`sudo /usr/local/sbin/awei-wechat-login --qr-image-only` 保持扫码进程运行，同时写入私有 `/var/lib/awei-wechat/wechat-login.png`（600）。图片为本机生成的无损 PNG、整数倍像素及四模块白边，无第三方二维码服务。运维可通过现有 SSH 安全取得图片并展示给本人；不要发布到公开网站或提交 Git。刷新二维码会原子替换图片，结束/失败时删除。图片对应短时登录挑战，不包含登录成功后返回的 bot token。微信消息服务仍不会自动启动。
