import assert from "node:assert/strict";
import { test } from "node:test";
import { aweiIngress } from "../src/awei/ingress.js";
import { AweiController, parsePlan } from "../src/awei/controller.js";
import { CodexRouter } from "../src/codex/router.js";
import { WeChatAcpBridge } from "../src/bridge.js";
import { defaultConfig } from "../src/config.js";
import type { Rpc } from "../src/codex/client.js";
const message = (text: string, voice = false) => ({ message_type: 1, from_user_id: "owner", context_token: "ctx",
  item_list: voice ? [{ type: 3, voice_item: { text } }] : [{ type: 1, text_item: { text } }] });
test("Awei wake is start-only; speech transcript and business escape have deterministic destinations", () => {
  assert.deepEqual(aweiIngress(message("阿维，找会话")), { kind: "assistant", text: "找会话", voice: false });
  assert.deepEqual(aweiIngress(message("阿维帮我找会话", true)), { kind: "assistant", text: "帮我找会话", voice: true });
  assert.equal(aweiIngress(message("正文提到阿维，找会话")).kind, "unchanged");
  assert.equal(aweiIngress(message("阿威，切换")).kind, "assistant");
  assert.deepEqual(aweiIngress(message("转给当前会话：阿维，切换")), { kind: "business", text: "阿维，切换", voice: false });
  assert.deepEqual(aweiIngress(message("修改行程", true)), { kind: "business", text: "修改行程", voice: true });
  assert.equal(aweiIngress(message("", true)).kind, "untranscribed");
});
class Backend implements Rpc {
  calls: { method: string; params: any }[] = [];
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/list") return { data: [{ id: "A", name: "埃及旅行" }, { id: "B", name: "工作计划" }], nextCursor: "next-list" } as T;
    if (method === "thread/turns/list") return { data: [{ id: "T", items: [
      { type: "reasoning", text: "HIDDEN" }, { type: "agentMessage", phase: "commentary", text: "HIDDEN" },
      { type: "userMessage", content: [{ type: "text", text: "行程" }] }, { type: "agentMessage", text: "计划" },
    ] }], nextCursor: params.cursor ? null : "older" } as T;
    throw new Error("Unexpected backend call: " + method);
  }
  onEvent() { return () => {}; }
  async close() {}
}
function setup(plans: object[]) {
  const rpc = new Backend(), router = new CodexRouter(rpc, "/work");
  const prompts: string[] = [], events: string[] = [], output: string[] = [];
  const model = { async ask(prompt: string) { prompts.push(prompt); const plan = plans.shift(); if (!plan) throw new Error("No plan"); return JSON.stringify(plan); }, async close() { events.push("close-model"); } };
  const ctl = new AweiController(model, router, { async release() { events.push("release"); return "released"; }, async quit() { events.push("quit"); return "quit"; }, async off() { return "off"; } });
  return { rpc, router, ctl, prompts, events, output, reply: async (t: string) => { output.push(t); } };
}
test("ACP plans search actual candidates then select without starting a business turn", async () => {
  const f = setup([{ action: "search", query: "埃及" }, { action: "select", ref: "1" }]);
  await f.ctl.handle("u", "切到埃及旅行", f.reply);
  assert.equal(f.router.assistantContext("u").current?.id, "A");
  assert.match(f.output.at(-1)!, /已切换/);
  assert.deepEqual(f.rpc.calls.map(c => c.method), ["thread/list"]);
  assert.equal(f.rpc.calls[0].params.limit, 50);
  assert.match(f.prompts[1], /埃及旅行/);
  await f.router.close();
});
test("unknown IDs and arbitrary shell/action fields are rejected", async () => {
  assert.throws(() => parsePlan('{"action":"shell","command":"rm"}'));
  assert.throws(() => parsePlan('{"action":"select","ref":"A","command":"rm"}'));
  const f = setup([{ action: "select", ref: "invented" }]);
  await f.ctl.handle("u", "切换", f.reply);
  assert.match(f.output.at(-1)!, /不在当前有效/);
  assert.equal(f.router.selected("u"), false);
  await f.router.close();
});
test("candidate expiry and cross-user IDs cannot switch a session", async () => {
  const f = setup([]); await f.router.assistantSearch("u");
  assert.throws(() => f.router.assistantSelect("other", "A"), /不在/);
  (f.router as any).users.get("u").listAt = 1;
  assert.throws(() => f.router.assistantSelect("u", "1"), /不在/);
  await f.router.close();
});
test("history pagination binds to selected thread and excludes tools/reasoning/commentary", async () => {
  const f = setup([]); await f.router.assistantSearch("u"); f.router.assistantSelect("u", "1");
  const first = await f.router.assistantHistory("u", undefined, 10, false);
  assert.doesNotMatch(first, /HIDDEN/); assert.match(first, /行程/);
  await f.router.assistantHistory("u", undefined, 10, true);
  assert.equal(f.rpc.calls.at(-1)!.params.cursor, "older");
  f.router.assistantSelect("u", "2");
  await assert.rejects(f.router.assistantHistory("u", undefined, 10, true), /没有可继续/);
  await f.router.close();
});
test("release and desktop quit require exact confirmation and close own inference first", async () => {
  const f = setup([{ action: "release" }, { action: "quit" }]);
  await f.ctl.handle("u", "交回电脑", f.reply);
  assert.deepEqual(f.events, []);
  await f.ctl.handle("u", "确认退出", f.reply);
  assert.deepEqual(f.events, []);
  await f.ctl.handle("u", "关闭桌面", f.reply);
  await f.ctl.handle("u", "确认退出", f.reply);
  assert.deepEqual(f.events, ["close-model", "quit"]);
  await f.ctl.handle("u", "确认退出", f.reply);
  assert.equal(f.events.length, 2);
  await f.router.close();
});
test("summary uses only retrieved history and is labelled partial", async () => {
  const f = setup([{ action: "summarize" }, { summary: "讨论了行程计划" }]);
  await f.router.assistantSearch("u"); f.router.assistantSelect("u", "1");
  await f.ctl.handle("u", "总结", f.reply);
  assert.match(f.output.at(-1)!, /不是全部会话/);
  assert.doesNotMatch(f.prompts.at(-1)!, /HIDDEN/);
  await f.router.close();
});
test("Awei failure never falls back into a business turn", async () => {
  const f = setup([]);
  await f.ctl.handle("u", "找一下会话", f.reply);
  assert.match(f.output.at(-1)!, /未转发给业务会话/);
  assert.equal(f.rpc.calls.length, 0);
  await f.router.close();
});
test("bridge serializes wake/selection before next voice and does not execute voice slash commands", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  b.tokenData = { userId: "owner" };
  let selected = false;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  b.handleAwei = async (_u: string, text: string) => { await gate; calls.push(text); selected = true; };
  b.sendReply = async () => {};
  b.codexRouter = { selected: () => selected, async handleInput(_u: string, input: any) { calls.push(input[0].text); } };
  b.quitDesktop = async () => { throw new Error("voice cannot become raw command"); };
  const first = b.handleMessage(message("阿维，切换"));
  const second = b.handleMessage(message("/acp codex quit", true));
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, ["切换", "/acp codex quit"]);
  await b.handleMessage({ ...message("阿维，切换"), from_user_id: "other" });
  assert.equal(calls.length, 2);
});
test("untranscribed voice is explained and never blindly forwarded", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  b.tokenData = { userId: "owner" }; const out: string[] = [];
  b.codexRouter = {}; b.sendReply = async (_u: string, _c: string, text: string) => out.push(text);
  await b.handleMessage(message("", true));
  assert.match(out[0], /没有附带转写/);
});

 test("speech homophones route only explicit wake prefixes and preserve escape", () => {
  for (const voice of [false, true]) {
    for (const name of ["阿伟", "阿唯", "阿威", "啊维", "A维", "a 微", "Ａ薇", "阿維", "阿魏"]) {
      assert.deepEqual(aweiIngress(message(name + "关闭电脑上的 codex。", voice)), { kind: "assistant", text: "关闭电脑上的 codex。", voice });
      assert.deepEqual(aweiIngress(message(name + "，确认退出。", voice)), { kind: "assistant", text: "确认退出。", voice });
    }
    for (const text of ["正文提到阿伟", "潘伟确认退出。", "维修电脑", "API 调用", "埃及旅行", "请问阿维怎么用"]) {
      assert.equal(aweiIngress(message(text, voice)).kind, voice ? "business" : "unchanged");
    }
    assert.deepEqual(aweiIngress(message("转给当前会话：阿伟，关闭电脑", voice)), { kind: "business", text: "阿伟，关闭电脑", voice });
  }
 });
 test("spoken confirmation punctuation preserves matching pending authorization", async () => {
   const f = setup([{ action: "quit" }]);
   await f.ctl.handle("u", "关闭桌面", f.reply);
   await f.ctl.handle("u", "确认退出。", f.reply);
   assert.deepEqual(f.events, ["close-model", "quit"]);
   const g = setup([]);
   await g.ctl.handle("u", "确认退出。", g.reply);
   assert.deepEqual(g.events, []);
   assert.match(g.output.join("\n"), /有效待确认/);
 });
test("acknowledgments do not invoke model, tools or actions", async () => {
 for(const text of ["收到啦","收到啦！","谢谢你","好的。"]){
  const f=setup([]);await f.ctl.handle("u",text,f.reply);
  assert.deepEqual(f.prompts,[]);assert.deepEqual(f.rpc.calls,[]);assert.deepEqual(f.events,[]);
  assert.match(f.output[0],/有需要随时/);
 }
});
test("social chat has its own action while research answers still require sources", async () => {
 const f=setup([{action:"chat",text:"你好，有什么可以帮你的？"}]);
 await f.ctl.handle("u","你好呀",f.reply);assert.match(f.output.at(-1)!,/你好/);
 assert.throws(()=>parsePlan('{"action":"answer","text":"好的，有需要随时叫阿维。","sources":[]}'),/MODEL_OUTPUT.*sources/);
});
