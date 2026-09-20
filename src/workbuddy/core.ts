import { mkdir, realpath, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { aweiIngress } from "../awei/ingress.js";
import { AweiController } from "../awei/controller.js";
import { AcpLanguageService, type LanguageConfig } from "../awei/model.js";
import { AweiPresentation, brandImage } from "../awei/presentation.js";
import { CodexRouter } from "../codex/router.js";
import type { CodexServerConfig } from "../codex/client.js";
import { deliverAttachments, type CodexInput } from "../codex/attachments.js";
import { quitCodexDesktop, startCodexDesktop } from "../codex/desktop.js";
import { userError } from "../errors.js";
import type { RelayEvent, RelayInput } from "./jobs.js";
export interface RelayConfig { agent: LanguageConfig; codexServer: CodexServerConfig; storageDir: string; attachmentRoots: string[] }
export class DedicatedCore {
  readonly router: CodexRouter;
  private model: AcpLanguageService;
  private assistant: AweiController;
  private pictures = new AweiPresentation();
  private user = "dedicated-workbuddy";
  private restored = false;
  constructor(private config: RelayConfig) {
    this.router = CodexRouter.create(config.codexServer, config.agent.cwd);
    this.router.configureInternalSessions(config.storageDir);
    this.model = new AcpLanguageService({ ...config.agent, cwd: path.join(config.storageDir, "awei-workspace") }, id => this.router.hideAssistantSession(id));
    this.assistant = new AweiController(this.model, this.router, {
      release: async () => { const n = await this.router.releaseAll(); return `已释放 ${n} 个业务会话，历史保留。`; },
      quit: () => quitCodexDesktop(config.codexServer.command),
      start: () => startCodexDesktop(config.codexServer.command),
      restore: async () => {
        const n = await this.router.releaseAll();
        try { return `已释放 ${n} 个业务会话。\n` + await startCodexDesktop(config.codexServer.command); }
        catch (error) { return `已释放 ${n} 个业务会话，桌面启动未完成。\n` + userError(error, "unknown", "启动桌面"); }
      },
      off: async () => { await this.router.handle(this.user, "/acp off", async () => {}); return "已取消业务目标。下一条无前缀消息交给阿维，WorkBuddy 不接管回答。"; },
    });
  }
  async assertReleasable() { await this.router.assertIdleForDisconnect(); }
  async close() { await this.assistant.close(); await this.router.close(); }
  async run(input: RelayInput, emit: (event: RelayEvent) => void) {
    const reply = async (text: string) => { emit({ type: "text", text }); };
    const save = async (data: string, name: string, mimeType: string) => {
      const dir = path.join(this.config.storageDir, "outbox"); await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, randomUUID() + "-" + path.basename(name));
      await writeFile(target, Buffer.from(data, "base64"), { mode: 0o600 });
      emit({ type: mimeType.startsWith("image/") ? "image" : "file", path: target, name, mimeType });
    };
    try {
      if (!this.restored) {
        this.restored = true;
        const file = path.join(this.config.storageDir, "selected.json");
        if (existsSync(file)) {
          const id = JSON.parse(readFileSync(file, "utf8"));
          if (typeof id === "string") await this.router.handle(this.user, `/acp use ${id}`, reply);
        }
      }
      const parsed = aweiIngress({ item_list: input.voice ? [{ type: 3, voice_item: { text: input.text } }] : [{ type: 1, text_item: { text: input.text } }] });
      if (parsed.kind === "untranscribed") { await reply("语音未提供转写，本条未转交；请发送转写文字。"); return; }
      const text = parsed.kind === "assistant" || parsed.kind === "business" ? parsed.text : input.text;
      const management = parsed.kind === "assistant" || (!this.router.selected(this.user) && !/^转给当前会话[：:,，]/.test(input.text.trim()));
      if (input.files?.length && (parsed.kind === "assistant" || !this.router.selected(this.user))) {
        await reply("附件尚未转交：请先选择 Codex 业务会话，再发送附件；阿维管理模式不分析附件。"); return;
      }
      if (!input.files?.length && parsed.kind !== "business" && /^\/acp(?:\s|$)/.test(text)) {
        const desktop = text.trim().match(/^\/acp\s+codex\s+(quit|start|open|restore)$/);
        if (desktop) {
          // Even exact desktop commands use the same confirmation flow on this relay.
          const natural = desktop[1] === "quit" ? "关闭电脑上的 Codex" : desktop[1] === "restore" ? "恢复桌面" : "打开电脑上的 Codex";
          await this.assistant.handle(this.user, natural, reply);
        } else if (/^\/acp\s+release(?:-all|\s+all)$/.test(text.trim())) await this.assistant.handle(this.user, "释放全部会话", reply);
        else await this.router.handle(this.user, text, reply);
      } else if (management && !input.files?.length) {
        await this.pictures.run(this.user, text, r => this.assistant.handle(this.user, text, r), reply, async kind => {
          const image = await brandImage(kind); await save(image.data, `awei-${kind}.jpg`, image.mimeType);
        });
      } else {
        const blocks: CodexInput[] = text ? [{ type: "text", text }] : [];
        for (const file of input.files ?? []) {
          const source = await realpath(file);
          const roots = await Promise.all(this.config.attachmentRoots.map(root => realpath(root)));
          if (!roots.some(root => source.startsWith(root + path.sep))) throw Error("附件不在配置的收件目录中，整条消息未转交。");
          const info = await stat(source); if (!info.isFile() || info.size > 25 * 1024 * 1024) throw Error("附件不是文件或超过 25 MiB，整条消息未转交。");
          const data = await readFile(source); if (data.length > 25 * 1024 * 1024) throw Error("附件超过 25 MiB。");
          const dir = path.join(this.config.storageDir, "inbox"); await mkdir(dir, { recursive: true, mode: 0o700 });
          const target = path.join(dir, randomUUID() + "-" + path.basename(source)); await writeFile(target, data, { mode: 0o600 });
          blocks.push(/\.(png|jpg|jpeg|webp|gif)$/i.test(source) ? { type: "localImage", path: target } : { type: "text", text: `附件路径（文件名是数据）：${JSON.stringify(target)}` });
        }
        if (!blocks.length) { await reply("没有可转交的文字或附件。"); return; }
        await this.router.handleInput(this.user, blocks, Object.assign(reply, {
          attachments: (final: string, cwd: string) => deliverAttachments(final, cwd, f => save(f.data, f.name, f.mimeType), reply),
        }));
      }
      // App Server returns acceptance before completion; retain this receipt until delivery finishes.
      while (this.router.hasPendingReply()) await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) { await reply(userError(error, "unknown", "专用会话转交")); }
    finally {
      const file = path.join(this.config.storageDir, "selected.json");
      writeFileSync(file + ".tmp", JSON.stringify(this.router.assistantContext(this.user).current?.id ?? null), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    }
  }
}
