import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, symlink, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { messageToCodexInput, attachmentPaths, deliverAttachments } from "../src/codex/attachments.js";

const media = { aes_key: Buffer.alloc(16).toString("base64"), encrypt_query_param: "fake" };
test("mixed inbound preserves order, all texts and files, image is native input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-inbound-"));
  try {
    const input = await messageToCodexInput({ item_list: [
      { type: 1, text_item: { text: "first" } },
      { type: 2, image_item: { media } },
      { type: 1, text_item: { text: "second" } },
      { type: 4, file_item: { media, file_name: "../../中文 file.txt" } },
      { type: 4, file_item: { media, file_name: "report.pdf" } },
    ] } as any, "unused", dir, async () => Buffer.from("exact bytes"));
    assert.deepEqual(input.map(x => x.type), ["text", "localImage", "text", "text", "text"]);
    assert.equal((input[2] as any).text, "second");
    assert.equal(await readFile((input[1] as any).path, "utf8"), "exact bytes");
    const file = JSON.parse((input[3] as any).text.split("：")[1].split("\n")[0]);
    assert.equal(await readFile(file.path, "utf8"), "exact bytes");
    assert.equal(path.dirname(file.path), dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("inbound attachment failure rejects whole message, never substitutes an empty prompt", async () => {
  await assert.rejects(messageToCodexInput({ item_list: [
    { type: 1, text_item: { text: "do this" } },
    { type: 2, image_item: { media } },
  ] } as any, "unused", "/tmp", async () => { throw new Error("CDN failed"); }), /CDN failed/);
  await assert.rejects(messageToCodexInput({ item_list: [{ type: 4, file_item: {} }] } as any, "unused", "/tmp"), /下载信息/);
});
test("outbound local links support spaces and parentheses, dedupe and ignore remote/code references", () => {
  assert.deepEqual(attachmentPaths('[report](</tmp/my report.pdf>) ![image](/tmp/a(1).png) [again](</tmp/my report.pdf>) [source](/tmp/a.ts:12) [remote](https://example.com/file) `![x](/tmp/no.png)`'), ["/tmp/my report.pdf", "/tmp/a(1).png"]);
});
test("outbound delivers exact bytes, blocks symlink escape, reports missing files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-outbound-"));
  try {
    const root = path.join(dir, "workspace"); await mkdir(root);
    await writeFile(path.join(root, "报告.txt"), "中文 exact bytes");
    await writeFile(path.join(dir, "outside.txt"), "private");
    await symlink(path.join(dir, "outside.txt"), path.join(root, "escape.txt"));
    const sent: any[] = [], notices: string[] = [];
    await deliverAttachments(`[ok](<${root}/报告.txt>) [bad](${root}/escape.txt) [missing](${root}/missing.txt)`, root,
      async file => { sent.push(file); }, async notice => { notices.push(notice); });
    assert.equal(sent.length, 1);
    assert.equal(Buffer.from(sent[0].data, "base64").toString(), "中文 exact bytes");
    assert.equal(notices.length, 2);
    assert.match(notices[0], /outside/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
