import assert from "node:assert/strict";
import { test } from "node:test";
import { AweiPresentation, brandImage } from "../src/awei/presentation.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("brand assets load as actual JPEGs", async () => {
  for (const kind of ["welcome", "working"] as const) {
    const data = Buffer.from((await brandImage(kind)).data, "base64");
    assert.equal(data.subarray(0, 3).toString("hex"), "ffd8ff");
  }
});
test("help sends welcome once per cooldown, text survives decoration failure", async () => {
  const p = new AweiPresentation(5), events: string[] = [];
  for (let i=0;i<2;i++) await p.run("u", "帮助", r => r("我是阿维，WorkHub 助手。"), async t => { events.push(t); }, async k => { events.push(k); throw Error("offline"); });
  assert.equal(events.filter(e => e === "welcome").length, 1);
  assert.equal(events.filter(e => e.startsWith("我是阿维")).length, 2);
});
test("slow work shows one image before result; fast work cancels its timer", async () => {
  const p = new AweiPresentation(10), events: string[] = [];
  await p.run("u", "搜索", async r => { await r("阿维：我看一下。"); await sleep(30); await r("答案"); }, async t => { events.push(t); }, async k => { events.push(k); });
  assert.deepEqual(events, ["阿维：我看一下。", "working", "答案"]);
  events.length = 0;
  await p.run("v", "搜索", async r => { await r("阿维：我看一下。"); await r("答案"); }, async t => { events.push(t); }, async k => { events.push(k); });
  await sleep(20);
  assert.deepEqual(events, ["阿维：我看一下。", "答案"]);
});
test("failed work clears timer; confirmation never arms decoration", async () => {
  const p = new AweiPresentation(10), images: string[] = [];
  await assert.rejects(p.run("u", "搜索", async r => { await r("阿维：我看一下。"); throw Error("failed"); }, async () => {}, async k => { images.push(k); }));
  await p.run("u", "确认退出", async r => { await sleep(20); await r("已退出"); }, async () => {}, async k => { images.push(k); });
  assert.deepEqual(images, []);
});
