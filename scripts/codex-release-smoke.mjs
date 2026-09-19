// Isolated real-protocol test: no production history, no model turn, no WeChat send.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRpc } from '../dist/src/codex/client.js';
import { CodexRouter } from '../dist/src/codex/router.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'wechat-release-smoke-'));
const config = { command: process.env.CODEX_PATH || '/Applications/ChatGPT.app/Contents/Resources/codex', args: ['app-server'], env: { CODEX_HOME: root }, requestTimeoutMs: 15000 };
const a = new CodexRpc(config), b = new CodexRpc(config);
const router = new CodexRouter(a, root);
try {
  const { thread } = await a.request('thread/start', { cwd: root, historyMode: 'legacy', persistExtendedHistory: true });
  console.log('Isolated thread created:', thread.id);
  // Persist a title so the no-turn thread can be resumed by the second server.
  await a.request('thread/name/set', { threadId: thread.id, name: 'Bridge release isolated test' });
  await assert.rejects(b.request('thread/resume', { threadId: thread.id }), /active writer/);
  console.log('Second server blocked by writer lock as expected');
  const count = await router.releaseAll();
  assert.equal(count, 1);
  const resumed = await b.request('thread/resume', { threadId: thread.id });
  assert.equal(resumed.thread.id, thread.id);
  console.log('After release: second server resumed same thread successfully');
  // The released transport reconnects lazily and remains useful.
  const list = await a.request('thread/list', { limit: 5, sourceKinds: [] });
  assert.ok(Array.isArray(list.data));
  console.log('Released bridge transport reconnects successfully; no model turns sent');
  console.log('Isolated evidence retained at:', root);
} finally { await router.close(); await b.close(); }
