import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexRouter } from '../src/codex/router.js';
import type { Rpc, ThreadSummary } from '../src/codex/client.js';
function backend(pages: ThreadSummary[][]): Rpc {
  return { async request<T>() { return { data: pages.shift()!, nextCursor: pages.length ? 'next' : null } as T; }, onEvent() { return () => {}; }, async close() {} };
}
test('deduplicates IDs within and across pages, preserves equal titles and refreshes numbering', async () => {
  const a = {id:'A',name:'同名'}, b = {id:'B',name:'同名'}, c = {id:'C',name:'第三个'};
  const r = new CodexRouter(backend([[a,a,b], [a,b,c], [a,b]]), '/work');
  await r.assistantSearch('u');
  assert.deepEqual(r.assistantContext('u').candidates.map(t=>t.id), ['A','B']);
  r.assistantSelect('u','2'); assert.equal(r.assistantContext('u').current?.id,'B');
  await r.assistantSearch('u','',true);
  assert.deepEqual(r.assistantContext('u').candidates.map(t=>t.id), ['C']);
  await r.assistantSearch('u');
  assert.deepEqual(r.assistantContext('u').candidates.map(t=>t.id), ['A','B']);
  await r.close();
});
test('internal IDs survive restart and dedicated workspace migrates older sessions in both lists', async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'list-registry-'));
  try {
    const first=new CodexRouter(backend([]),'/work'); first.configureInternalSessions(dir); first.hideAssistantSession('internal'); await first.close();
    const rows=[{id:'internal'}, {id:'old',cwd:path.join(dir,'awei-workspace')}, {id:'real',name:'你是阿维'}, {id:'real',name:'你是阿维'}];
    const r=new CodexRouter(backend([rows]),'/work');r.configureInternalSessions(dir);
    await r.assistantSearch('u'); assert.deepEqual(r.assistantContext('u').candidates.map(t=>t.id),['real']);await r.close();
    const next=new CodexRouter(backend([[{id:'old'}, ...rows]]),'/work'); next.configureInternalSessions(dir);
    const out:string[]=[];await next.handle('u','/acp list',async t=>{out.push(t);});
    assert.equal(out.join('').match(/real/g)?.length,1);assert.doesNotMatch(out.join(''),/internal|old/);await next.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
