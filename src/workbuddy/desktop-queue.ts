import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const root = path.join(os.homedir(), "Library/Application Support/SeanHomeAgent");
const proof = z.string().max(640).describe("在当前 WorkBuddy 会话的 Bash 工具执行 ~/Library/Application\\ Support/SeanHomeAgent/desktop-context，使用其输出。不要手填会话 ID。");
async function invoke(op: string, proof: string, data: Record<string,string>) {
  const [payload, signature] = proof.split(".");
  if (!payload || !signature || !/^[0-9a-f]{64}$/.test(signature)) throw Error("会话证明无效");
  const key = await readFile(path.join(root, "desktop-sign.key"));
  if (!timingSafeEqual(createHmac("sha256", key).update(payload).digest(), Buffer.from(signature,"hex"))) throw Error("会话证明无效");
  const [native, issued] = JSON.parse(Buffer.from(payload,"base64url").toString());
  const age = Date.now()/1000 - issued;
  if (!Number.isSafeInteger(issued) || age < -15 || age > 1800) throw Error("请在当前会话重新取得会话证明");
  const token = (await readFile(path.join(root,"desktop-engine.key"),"utf8")).trim();
  const r = await fetch("https://seanhome.awiki.info/session-api/homes/personal/engine", {
    method:"POST",redirect:"error",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},
    body:JSON.stringify({op,native,...data}),signal:AbortSignal.timeout(15000)
  });
  if (!r.ok) throw Error("阿维任务接口 "+r.status+"；请核对本会话配对与任务归属");
  return {content:[{type:"text" as const,text:JSON.stringify(await r.json())}]};
}
export function registerDesktopQueue(server:McpServer) {
  server.registerTool("awei_desktop_pair",{description:"将当前 WorkBuddy 桌面会话绑定到阿维指定队列。",inputSchema:{proof,code:z.string().max(80)}},({proof,code})=>invoke("desktop_pair",proof,{code}));
  server.registerTool("awei_desktop_claim",{description:"领取或找回本会话未完成的任务。只处理返回的任务；task=null 即结束。",inputSchema:{proof}},({proof})=>invoke("desktop_claim",proof,{}));
  server.registerTool("awei_desktop_finish",{description:"把本会话任务的实际正文交还原事项。",inputSchema:{proof,id:z.string().uuid(),text:z.string().min(1).max(100000)}},({proof,id,text})=>invoke("desktop_finish",proof,{id,text}));
}
