import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { issueTransfer, checkTransfer, consumeTransfer, readTransfer } from "../src/workbuddy/transfer.js";
const dir = () => mkdtempSync(path.join(os.tmpdir(), "awei-transfer-"));
test("issue → check → consume is single-use and case-insensitive", () => {
  const d = dir(); try {
    const t = issueTransfer(d, "owner");
    assert.equal(t.code.length, 6);
    assert.equal(checkTransfer(d, t.code.toLowerCase()).ok, true);
    consumeTransfer(d);
    assert.equal(readTransfer(d), null);
    assert.equal(checkTransfer(d, t.code).ok, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test("wrong code fails closed and keeps the ticket usable", () => {
  const d = dir(); try {
    const t = issueTransfer(d, "owner");
    const wrong = checkTransfer(d, "AAAAAA");
    assert.equal(wrong.ok, false);
    assert.equal(checkTransfer(d, t.code).ok, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test("expired ticket is rejected with a regeneration hint", () => {
  const d = dir(); try {
    writeFileSync(path.join(d, "transfer.json"), JSON.stringify({ code: "ACD234", issuedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), issuedBy: "owner" }));
    const r = checkTransfer(d, "ACD234");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /过期/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test("corrupted ticket file reads as absent, never throws", () => {
  const d = dir(); try {
    writeFileSync(path.join(d, "transfer.json"), "not-json");
    assert.equal(readTransfer(d), null);
    assert.equal(checkTransfer(d, "ACD234").ok, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
