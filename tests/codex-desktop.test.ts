import assert from "node:assert/strict";
import { test } from "node:test";
import { quitCodexDesktop, type DesktopProcess, type DesktopQuitDeps } from "../src/codex/desktop.js";
import { WeChatAcpBridge } from "../src/bridge.js";
import { defaultConfig } from "../src/config.js";

const command = "/Applications/ChatGPT.app/Contents/Resources/codex";
const app: DesktopProcess = { pid: 100, ppid: 1, executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" };
const desktopServer = { pid: 101, ppid: 100, executable: command };
const bridgeServer = { pid: 201, ppid: 200, executable: command };
function fake(snapshots: DesktopProcess[][]) {
  const requests: number[] = [];
  let index = 0;
  const deps: DesktopQuitDeps = {
    platform: "darwin", bridgePid: 200,
    async snapshot() { return snapshots[Math.min(index++, snapshots.length - 1)]; },
    async identity() { return { bundleId: "com.openai.codex", executable: "ChatGPT" }; },
    async requestQuit(_path, pid) { requests.push(pid); return true; },
    async sleep() {},
  };
  return { deps, requests };
}
test("quit targets desktop main process and verifies server exit while preserving bridge server", async () => {
  const f = fake([[app, desktopServer, bridgeServer], [bridgeServer]]);
  assert.match(await quitCodexDesktop(command, f.deps), /已确认其 App Server 进程停止/);
  assert.deepEqual(f.requests, [100]);
});
test("orphaned desktop server prevents successful release report", async () => {
  const f = fake([[app, desktopServer], [{ ...desktopServer, ppid: 1 }]]);
  await assert.rejects(quitCodexDesktop(command, f.deps, 2), /等待超时/);
  assert.deepEqual(f.requests, [100]);
});
test("desktop respawn and refused quit never cause force termination", async () => {
  const f = fake([[app, desktopServer], [{ ...app, pid: 102 }]]);
  await assert.rejects(quitCodexDesktop(command, f.deps, 2), /等待超时/);
  assert.deepEqual(f.requests, [100]);
  f.deps.requestQuit = async () => false;
  await assert.rejects(quitCodexDesktop(command, f.deps, 2), /未接受/);
});
test("already stopped does not relaunch desktop or claim all unrelated locks released", async () => {
  const f = fake([[bridgeServer]]);
  assert.match(await quitCodexDesktop(command, f.deps), /主进程当前未运行/);
  assert.deepEqual(f.requests, []);
});
test("wrong bundle, platform, path and desktop-owned bridge fail before quit", async () => {
  const f = fake([[app, desktopServer, { pid: 200, ppid: 101, executable: "node" }]]);
  await assert.rejects(quitCodexDesktop(command, f.deps), /独立运行/);
  await assert.rejects(quitCodexDesktop("codex", f.deps), /绝对/);
  f.deps.platform = "linux";
  await assert.rejects(quitCodexDesktop(command, f.deps), /macOS/);
  f.deps.platform = "darwin";
  f.deps.identity = async () => ({ bundleId: "com.openai.chat", executable: "ChatGPT" });
  await assert.rejects(quitCodexDesktop(command, f.deps), /未识别|不是已识别/);
  assert.deepEqual(f.requests, []);
});
function bridge() {
  const b = new WeChatAcpBridge(defaultConfig()) as any;
  b.tokenData = { userId: "owner" };
  const output: string[] = [];
  let quits = 0;
  b.sendReply = async (_u: string, _ctx: string, text: string) => { output.push(text); };
  b.quitDesktop = async () => { quits++; return "verified stopped"; };
  b.handleUserMessage = async () => { throw new Error("Must not invoke agent"); };
  return { b, output, quits: () => quits };
}
const message = (text: string, user = "owner") => ({ message_type: 1, from_user_id: user, context_token: "ctx", item_list: [{ type: 1, text_item: { text } }] });
test("owner command works without selecting a thread and returns verified result", async () => {
  const f = bridge();
  await f.b.handleMessage(message("/acp codex quit"));
  assert.equal(f.quits(), 1);
  assert.match(f.output[0], /正在请求/);
  assert.equal(f.output[1], "verified stopped");
});
test("nonowner, groups, missing owner and extra arguments cannot quit", async () => {
  const f = bridge();
  await f.b.handleMessage(message("/acp codex quit", "other"));
  await f.b.handleMessage({ ...message("/acp codex quit"), group_id: "group" });
  await f.b.handleMessage(message("/acp codex quit --force"));
  assert.match(f.output[0], /用法/);
  f.b.tokenData = {};
  await f.b.handleMessage(message("/acp codex quit"));
  assert.equal(f.quits(), 0);
});
test("failed acknowledgement prevents an unreported quit; quit errors are visible", async () => {
  const f = bridge();
  f.b.sendReply = async () => { throw new Error("WeChat unavailable"); };
  await assert.rejects(f.b.handleMessage(message("/acp codex quit")), /WeChat unavailable/);
  assert.equal(f.quits(), 0);
  const g = bridge();
  g.b.quitDesktop = async () => { throw new Error("timeout"); };
  await g.b.handleMessage(message("/acp codex quit"));
  assert.match(g.output[1], /退出未完成[\s\S]*TIMEOUT-/);
});
