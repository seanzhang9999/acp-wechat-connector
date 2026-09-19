# ACP WeChat Connector

通过微信远程继续 Mac 上的 Codex 会话，回到电脑后再交回 Codex 桌面 App。

这个项目面向个人使用：不需要引入 VS Code，也不要求微信和桌面同时控制一个会话。出门后在微信退出 Codex 桌面，选择原会话继续；回到本地前释放桥接持有的会话，再打开桌面继续工作。会话沿用同一份本地历史。

基于 [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp) 扩展，保留上游 MIT 许可和历史。上游负责微信 iLink 通道、ACP Agent 接入及媒体传输；本项目增加 Codex 会话选择、App Server 生命周期管理、目标会话附件路由，以及 macOS 桌面退出命令。原始使用说明见 [README.upstream.md](README.upstream.md)。

## 当前功能价值

- **远程关闭 Codex 桌面：**微信发送 `/acp codex quit`，桥接请求桌面正常退出，确认其 App Server 停止后反馈结果。微信桥接独立运行，继续接收消息。
- **访问最近五十个会话：**`/acp list` 每次显示 10 个，连续使用 `/acp more` 可浏览最近 50 个（有足够会话时）；后端有下一页时还可继续。支持关键词查找、编号选择和完整 ID 定位。
- **继续原来的工作：**选择后发送文字、图片或文件，任务结果通过微信返回；无需复制对话或为接管另建会话。
- **随时发起交还：**`/acp release-all` 释放原 ACP 连接及目标路由持有的全部会话。任务、审批、排队消息或附件发送尚未结束时会拒绝释放，完成后再试。
- **回到 PC 接着做：**收到释放成功回复后，重新打开 Codex 桌面 App，进入原会话继续。当前验证环境为 macOS，远程退出命令尚未实现 Windows 版本。

这是一套个人在微信与桌面之间轮流接管会话的工具。两端各自运行 App Server，同一会话的写入权需要先释放再接管；尚不支持桌面和微信实时共同控制。

## 典型使用流程

| 阶段 | 操作 |
| --- | --- |
| 出门后准备微信接管 | `/acp codex quit`，等待桌面及其服务退出的成功回复 |
| 查找会话 | `/acp list`，必要时 `/acp more` 或 `/acp list 关键词` |
| 选择目标 | `/acp use 编号` |
| 查看上下文 | `/acp recent`，显示最近 6 条可见文本消息 |
| 远程工作 | 直接发送文字、图片或文件；需要交付文件时直接向 Agent 提出 |
| 回到电脑前 | `/acp release-all`，等待成功回复 |
| 本地继续 | 打开 Codex 桌面 App，进入原会话 |

`/acp codex quit` 会退出整个桌面 App，可能中断桌面正在运行的任务。它采用正常退出，不强制结束；遇到退出确认、残留服务或超时会报告未完成。桥接目前无法可靠读取桌面全部任务的忙碌状态。

`/acp off` 只返回原 ACP 聊天，**不会释放会话占用**。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/acp help` | 查看命令帮助 |
| `/acp codex quit` | 正常退出 macOS Codex 桌面并检查服务停止 |
| `/acp list [关键词]` | 列出最近会话，每页 10 个 |
| `/acp more` | 下一页，编号仅对应最近一次显示的列表 |
| `/acp use <编号或完整 ID>` | 选择目标；选择本身不会启动任务 |
| `/acp current` | 查看当前目标 |
| `/acp recent [编号或完整 ID]` | 最近 6 条用户/助手文本消息 |
| `/acp reply <内容>` | 向当前目标发送文字 |
| `/acp send <编号或完整 ID> <内容>` | 向指定目标发送文字 |
| `/acp result` | 查看最近一次桥接发送的状态或结果 |
| `/acp new` | 在配置的工作目录创建并选择会话 |
| `/acp off` | 返回原 ACP 聊天 |
| `/acp release-all` | 释放桥接持有的全部会话，保留历史 |

`/acp` 路由及桌面退出命令仅接受微信扫码配对本人。未知命令不会传给模型执行。`/acp-config`、`/acp-cancel` 等上游命令仍针对原 ACP 会话，不会控制选中的 App Server 目标。

## 安装与启动

要求 Node.js 20+、可使用 iLink Bot API 的微信账号、已配置认证的本地 Codex。桌面退出功能要求 macOS，且 `codexServer.command` 指向桌面 App 内的 Codex 可执行文件。

```sh
git clone https://github.com/seanzhang9999/acp-wechat-connector.git
cd acp-wechat-connector
npm ci
npm run build
cp config.example.json config.local.json
```

编辑 `config.local.json` 的工作目录和 Codex 路径。示例保留两条连接：原 ACP Agent 和直接操作 Codex 会话的 App Server。ACP 适配器首次运行可能由 npx 下载；已有固定安装时可改为对应的绝对路径。

从独立终端启动桥接，使其不依赖 Codex 桌面窗口：

```sh
node dist/bin/wechat-acp.js --config config.local.json --instance personal-codex --daemon
```

首次配对时可在独立终端以前台方式运行同一命令（去掉 `--daemon`），完成二维码登录后正常停止，再以后台方式启动。避免两个进程同时轮询同一个微信账号。请保留首次登录时使用的 instance 名称。

这里的命令仍叫 `wechat-acp` 以兼容上游入口。**`npx wechat-acp@latest` 安装的是上游版本，不包含本仓库扩展。** 本仓库不自动发布 npm 包。

## 附件

微信入站支持多段文字及多个附件，按消息顺序转发。图片以本地图片输入交给 Codex；文件保留原始字节，保存到私有 inbox 后把路径交给目标会话。路径可见不代表 Agent 的沙盒一定有读取权限。

出站使用最终回答中的 `[文件名](<绝对路径>)` 或 `![图片](<绝对路径>)` 链接交付。桥接会提示 Agent 把产物保存在目标工作目录内，再通过微信上传发送。单文件最多 25 MiB，每轮最多 10 个出站附件。下载失败会阻止整条入站请求；出站文件读取或发送失败会提示原因。其他桌面任务的独立回复不会自动镜像到微信。

## 待改进：用自然语言管理会话的小 Agent

计划在桥接控制层增加一个轻量 Agent，使用户可以直接说：

- “切到昨天讨论埃及行程的那个会话。”
- “把这个会话前面十轮再给我看看。”
- “找一下最近讨论 ACP 的会话，先告诉我有哪些。”

该 Agent 应先检索会话元数据和必要的上下文，将自然语言转换为确定的查找、读取、选择操作。存在多个相似会话时返回文字候选项让用户选择；选中后的业务请求仍交给原目标会话，不自动新建替代会话，也不自动批准工具操作。

**目前尚未实现。** 当前只有关键词、编号/ID 和最近 6 条文本读取，没有历史对话翻页。后续需要补充按需读取更多历史、分页、上下文预算和选择歧义处理。

### 为什么优先自然语言，而不是 HTML 点击切换

当前接入的是微信 iLink Bot 专用消息通道，也是 OpenClaw 微信适配器所使用的通道类型；本项目不需要运行完整 OpenClaw。当前实现只使用消息和媒体收发，尚未发现或验证可以在这条聊天通道内嵌入任意 HTML 并接收点击回调的能力。

因此暂不把 HTML 会话选择器作为方案，优先采用自然语言和文字候选列表。外部网页链接与聊天内交互不是同一种能力；这里不宣称微信所有场景都不支持 HTML。

## 验证与边界

- 当前 macOS 构建与测试：244 项通过，1 项 Windows 专用测试跳过。
- 隔离的真实 App Server 测试验证：第二服务先因写入锁无法接管，释放后可恢复同一个测试会话；无需调用模型。
- 个人使用中已反馈桌面退出后微信消息进入原会话；这不等于所有双向附件和回到桌面的场景均已验收。
- 桌面退出的自动化测试使用模拟进程，不会在测试中真的退出用户桌面。
- 目标 App Server 的审批/动态工具请求不会被自动批准；独立服务可能因没有审批界面而等待。上游 ACP 权限处理是另一条路径，见上游说明。
- 历史可读不代表写入权已释放。释放失败、超时或传输状态不确定时不会自动复制会话或重发任务。

```sh
npm run build
npm test
CODEX_PATH=/absolute/path/to/codex node scripts/codex-release-smoke.mjs
```

详见 [实现、配置与交接研究](docs-codex-routing.md)。生产登录状态、token、会话历史、附件、二维码、日志与本机启动脚本均不属于公开源码。

## 来源与许可

基于 [WeChat ACP](https://github.com/formulahendry/wechat-acp)，上游基线提交 `4b787a5`。保留 [MIT LICENSE](LICENSE) 及上游贡献历史。WeChat、Codex、ACP、OpenClaw 等名称归各自项目或权利人；本项目是个人扩展，非官方产品。
