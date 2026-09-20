import { readFile } from "node:fs/promises";
import type { AgentImage } from "../acp/client.js";
export type BrandKind = "welcome" | "working";
export async function brandImage(kind: BrandKind): Promise<AgentImage> {
  // Source execution and the compiled distribution have different module depths.
  const candidates = ["../../../web-demo/assets/", "../../web-demo/assets/"];
  for (const base of candidates) {
    try { return { data: (await readFile(new URL(`${base}awei-${kind}.jpg`, import.meta.url))).toString("base64"), mimeType: "image/jpeg" }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`Missing Awei brand asset: ${kind}`);
}

/** Optional decoration never changes routing, approval or the assistant's result. */
export class AweiPresentation {
  private last = new Map<string, number>();
  constructor(private delayMs = 10_000, private cooldownMs = 30 * 60_000) {}
  async run(user: string, request: string,
    handle: (reply: (text: string) => Promise<void>) => Promise<void>,
    reply: (text: string) => Promise<void>, send: (kind: BrandKind) => Promise<void>): Promise<void> {
    const show = async (kind: BrandKind) => {
      const key = `${user}:${kind}`, now = Date.now();
      if (now - (this.last.get(key) ?? -Infinity) < this.cooldownMs) return;
      this.last.set(key, now);
      try { await send(kind); }
      catch { console.warn(`[awei-brand] ${kind} image unavailable; continuing text response`); }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let image: Promise<void> = Promise.resolve();
    const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
    try {
      await handle(async text => {
        if (text === "阿维：我看一下。") {
          await reply(text);
          // Only inference work arms the timer; help and pending confirmations do not.
          if (!timer) timer = setTimeout(() => { image = show("working"); }, this.delayMs);
          return;
        }
        cancel();
        await image;
        await reply(text);
        if (/^(帮助|你能做什么)?$/.test(request.trim()) && text.startsWith("我是阿维")) await show("welcome");
      });
    } finally { cancel(); await image; }
  }
}
