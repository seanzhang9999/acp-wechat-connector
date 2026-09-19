import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexRouter } from "../src/codex/router.js";
import { visibleMessages, type Rpc } from "../src/codex/client.js";
import { WeChatAcpBridge } from "../src/bridge.js";
import { defaultConfig } from "../src/config.js";
class Fake implements Rpc {
  calls: Array<{ method: string; params: any }> = [];
  listener: (m: string, p: any) => void = () => {};
  failResume = false;
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/list")
      return {
        data: [
          { id: "A", name: "Alpha" },
          { id: "B", name: "Beta" },
        ],
      } as T;
    if (method === "thread/read")
      return { thread: { id: params.threadId, turns: [] } } as T;
    if (method === "thread/resume") {
      if (this.failResume) throw new Error("already has an active writer");
      return { thread: { id: params.threadId, status: { type: "idle" } } } as T;
    }
    if (method === "turn/start")
      return { turn: { id: "turn-" + params.threadId } } as T;
    return {} as T;
  }
  onEvent(h: (m: string, p: any) => void) {
    this.listener = h;
    return () => {};
  }
  async close() {}
}
test("list snapshots isolate users; invalid commands never invoke turns", async () => {
  const f = new Fake(),
    r = new CodexRouter(f, "/test"),
    out: string[] = [];
  const reply = async (t: string) => {
    out.push(t);
  };
  await r.handle("u", "/acp list", reply);
  await r.handle("v", "/acp use 1", reply);
  assert.match(out.at(-1)!, /编号/);
  await r.handle("u", "/acp use 2", reply);
  await r.handle("u", "/acp current", reply);
  assert.match(out.at(-1)!, /Beta/);
  await r.handle("u", "/acp nonsense", reply);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  await r.close();
});
test("send retains original target and correlates exact turn after switching", async () => {
  const f = new Fake(),
    r = new CodexRouter(f, "/test"),
    out: string[] = [];
  const reply = async (t: string) => {
    out.push(t);
  };
  await r.handle("u", "/acp list", reply);
  await r.handle("u", "/acp use 1", reply);
  await r.handle("u", "/acp reply hello\nworld", reply);
  await r.handle("u", "/acp use 2", reply);
  assert.equal(
    f.calls.find((c) => c.method === "turn/start")!.params.input[0].text,
    "hello\nworld",
  );
  f.listener("turn/completed", {
    threadId: "A",
    turn: { id: "old", status: "completed", items: [] },
  });
  assert.doesNotMatch(out.at(-1)!, /old/);
  f.listener("item/completed", {
    threadId: "A",
    turnId: "turn-A",
    item: {
      id: "item",
      type: "agentMessage",
      phase: "final_answer",
      text: "correct reply",
    },
  });
  f.listener("turn/completed", {
    threadId: "A",
    turn: { id: "turn-A", status: "completed", items: [] },
  });
  assert.match(out.at(-1)!, /Alpha.*\n轮次 turn-A.*\ncorrect reply/);
  await r.close();
});
test("writer conflict never forks, retries or falls back to a new conversation", async () => {
  const f = new Fake();
  f.failResume = true;
  const r = new CodexRouter(f, "/test");
  const out: string[] = [];
  const reply = async (t: string) => {
    out.push(t);
  };
  await r.handle("u", "/acp list", reply);
  await r.handle("u", "/acp send 1 hello", reply);
  assert.match(out.at(-1)!, /另一个 Codex/);
  assert.deepEqual(
    f.calls.map((x) => x.method),
    ["thread/list", "thread/resume"],
  );
  await r.close();
});
test("recent output excludes tool data and reasoning", () => {
  assert.equal(
    visibleMessages([
      {
        id: "t",
        status: "completed",
        items: [
          { type: "reasoning", text: "secret" },
          { type: "userMessage", content: [{ type: "text", text: "hi" }] },
          { type: "agentMessage", text: "hello" },
          { type: "mcpToolCall", text: "secret" },
        ],
      },
    ]),
    "用户：hi\n\nCodex：hello",
  );
});
test("bridge intercepts /acp even without backend, rejects nonowner", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  const output: string[] = [];
  let enqueued = 0;
  b.tokenData = { userId: "owner" };
  b.sendReply = async (_u: string, _c: string, s: string) => output.push(s);
  b.handleUserMessage = async () => enqueued++;
  const msg = {
    message_type: 1,
    from_user_id: "owner",
    context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "/acp list" } }],
  };
  await b.handleMessage(msg);
  assert.match(output[0], /未配置/);
  assert.equal(enqueued, 0);
  await b.handleMessage({ ...msg, from_user_id: "other" });
  assert.equal(output.length, 1);
  assert.equal(enqueued, 0);
});
test("timeout does not repeat turn/start", async () => {
  const f = new Fake(),
    r = new CodexRouter(f, "/test", 15),
    out: string[] = [];
  const reply = async (t: string) => {
    out.push(t);
  };
  await r.handle("u", "/acp list", reply);
  await r.handle("u", "/acp send 1 hello", reply);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(out.at(-1)!, /超时/);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  await r.close();
});
test("completion arriving before turn/start response is correlated", async () => {
  const f = new Fake();
  const orig = f.request.bind(f);
  f.request = async function <T>(method: string, p: any): Promise<T> {
    if (method === "turn/start")
      this.listener("turn/completed", {
        threadId: p.threadId,
        turn: {
          id: "turn-" + p.threadId,
          status: "completed",
          items: [{ type: "agentMessage", text: "early result" }],
        },
      });
    return orig(method, p);
  };
  const r = new CodexRouter(f, "/test"),
    out: string[] = [];
  const reply = async (t: string) => {
    out.push(t);
  };
  await r.handle("u", "/acp list", reply);
  await r.handle("u", "/acp send 1 hello", reply);
  assert.match(out.at(-1)!, /early result/);
  await r.close();
});
test("ordinary text waits for a pending selection command", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  let selected = false,
    forwarded = "";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.tokenData = { userId: "owner" };
  b.sendReply = async () => {};
  b.handleUserMessage = async () => {
    throw new Error("Must not enter ACP session");
  };
  b.codexRouter = {
    selected: () => selected,
    handle: async (_u: string, text: string) => {
      if (text === "/acp use 1") {
        await gate;
        selected = true;
      } else forwarded = text;
    },
  };
  const msg = (text: string) => ({
    message_type: 1,
    from_user_id: "owner",
    context_token: "ctx",
    item_list: [{ type: 1, text_item: { text } }],
  });
  const first = b.handleMessage(msg("/acp use 1"));
  const second = b.handleMessage(msg("next instruction"));
  release();
  await Promise.all([first, second]);
  assert.equal(forwarded, "next instruction");
});

test("release validates live status, resets own service and resumes again after release", async () => {
  class Releasable extends Fake {
    resets = 0;
    status = "idle";
    async request<T>(method: string, params: any): Promise<T> {
      if (method === "thread/loaded/list") return { data: ["A"] } as T;
      if (method === "thread/read") return { thread: { id: params.threadId, status: { type: this.status } } } as T;
      return super.request(method, params);
    }
    async reset() { this.resets++; }
  }
  const f = new Releasable(), r = new CodexRouter(f, "/test");
  const reply = async () => {};
  try {
    await r.handle("u", "/acp list", reply);
    await r.handle("u", "/acp use 1", reply);
    f.status = "active";
    await assert.rejects(r.releaseAll(), /仍在执行/);
    assert.equal(f.resets, 0);
    f.status = "idle";
    assert.equal(await r.releaseAll(), 1);
    assert.equal(f.resets, 1);
    assert.equal(r.selected("u"), false);
    await r.handle("u", "/acp use 1", reply);
    await r.handle("u", "after release", reply);
    assert.equal(f.calls.filter(c => c.method === "thread/resume").length, 1);
    await assert.rejects(r.releaseAll(), /执行中/);
  } finally { await r.close(); }
});

test("a timed-out request with unresolved approval cannot be released", async () => {
  const f = new Fake(), r = new CodexRouter(f, "/test", 5);
  try {
    await r.handle("u", "/acp list", async () => {});
    await r.handle("u", "/acp send 1 hello", async () => {});
    f.listener("server/request", { params: { threadId: "A" } });
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(r.releaseAll(), /审批/);
  } finally { await r.close(); }
});

test("attachments follow original target and exact completed turn, never commentary or old turns", async () => {
  const f = new Fake(), r = new CodexRouter(f, "/test");
  const delivered: string[] = [];
  const reply = Object.assign(async (_text: string) => {}, { attachments: async (text: string, cwd: string) => { delivered.push(cwd + text); } });
  try {
    await r.handle("u", "/acp list", reply);
    await r.handle("u", "/acp use 1", reply);
    await r.handleInput("u", [{ type: "text", text: "explain" }, { type: "localImage", path: "/tmp/img.png" }], reply);
    assert.deepEqual(f.calls.find(c => c.method === "turn/start")!.params.input.slice(0, 2), [{ type: "text", text: "explain" }, { type: "localImage", path: "/tmp/img.png" }]);
    await r.handle("u", "/acp use 2", reply);
    f.listener("turn/completed", { threadId: "A", turn: { id: "old", items: [{ type: "agentMessage", text: "bad" }] } });
    f.listener("turn/completed", { threadId: "A", turn: { id: "turn-A", status: "completed", items: [
      { type: "agentMessage", phase: "commentary", text: "private interim" },
      { type: "agentMessage", text: "[file](/test/a.pdf)" },
    ] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, ["/test[file](/test/a.pdf)"]);
  } finally { await r.close(); }
});

test("bridge release-all covers ACP and routed service without invoking a model", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  b.tokenData = { userId: "owner" };
  const called: string[] = [], output: string[] = [];
  b.sendReply = async (_u: string, _c: string, text: string) => output.push(text);
  b.sessionManager = { assertReleasable() { called.push("acp-check"); }, async releaseAll() { called.push("acp-release"); return 1; } };
  b.codexRouter = { async assertReleasable() { called.push("router-check"); }, async releaseAll() { called.push("router-release"); return 2; } };
  await b.handleMessage({ message_type: 1, from_user_id: "owner", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "/acp release-all" } }] });
  assert.deepEqual(called, ["acp-check", "router-check", "acp-release", "router-release"]);
  assert.match(output[0], /ACP 1 个，目标路由 2 个/);
});

test("bridge forwards multiple text items as one ordered turn", async () => {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  b.tokenData = { userId: "owner" };
  let received: any;
  b.codexRouter = { selected: () => true, async handleInput(_u: string, input: any) { received = input; } };
  await b.handleMessage({ message_type: 1, from_user_id: "owner", context_token: "ctx", item_list: [
    { type: 1, text_item: { text: "first" } }, { type: 1, text_item: { text: "second" } },
  ] });
  assert.deepEqual(received, [{ type: "text", text: "first" }, { type: "text", text: "second" }]);
});
