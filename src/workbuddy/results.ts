import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RelayEvent } from "./jobs.js";
/** Preserve the receipt JSON and expose images as actual MCP image blocks, not just file paths. */
export async function relayResult(value: unknown, storageDir: string) {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: JSON.stringify(value) },
  ];
  const events = (value as { events?: RelayEvent[] })?.events ?? [];
  let bytes = 0;
  for (const event of events) {
    if (event.type !== "image" || !event.path || !/^image\/(jpeg|png|gif|webp)$/.test(event.mimeType ?? "")) continue;
    try {
      const root = await realpath(path.join(storageDir, "outbox")), file = await realpath(event.path);
      if (!file.startsWith(root + path.sep)) throw Error("Image outside relay outbox");
      const info = await stat(file);
      if (info.size + bytes > 8 * 1024 * 1024) throw Error("Inline image budget exceeded");
      const data = await readFile(file); bytes += data.length;
      if (bytes > 8 * 1024 * 1024) throw Error("Inline image budget exceeded");
      content.push({ type: "image", data: data.toString("base64"), mimeType: event.mimeType! });
    } catch {
      content.push({ type: "text", text: "图片无法内联交付；请明确告知用户，不能将文件附件标为图片发送成功。" });
    }
  }
  return { content };
}
