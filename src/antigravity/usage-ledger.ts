import { mkdir, open, rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** One durable record per invocation. Never stores prompts, outputs or credentials. */
export class UsageLedger {
  readonly id = randomUUID();
  private record: Record<string, unknown> = { schema: 1, id: this.id, provider: 'antigravity', startedAt: new Date().toISOString(), status: 'started', promptStarted: false };
  constructor(private dir: string, modelId: string | null) { this.record.modelId = modelId; }
  async write(patch: Record<string, unknown> = {}) {
    Object.assign(this.record, patch);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dir, `${this.id}.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.record) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path.join(this.dir, `${this.id}.json`));
    const directory = await open(this.dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export async function summarizeUsage(dir: string) {
  const records: any[] = [];
  for (const file of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const r = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (r.schema !== 1 || r.provider !== 'antigravity' || !['started','prompt_started','passed','discovered','failed','unknown'].includes(r.status)) throw Error('invalid_usage_record');
    records.push(r);
  }
  const groups: Record<string, {invocations:number; submittedPrompts:number; passed:number; failed:number; unknown:number; tokenReportedCalls:number; reportedTokens:Record<string,number>}> = {};
  for (const r of records) {
    const key = typeof r.modelId === 'string' ? r.modelId : '(discovery)';
    if (!Object.hasOwn(groups, key)) Object.defineProperty(groups, key, {value:{invocations:0,submittedPrompts:0,passed:0,failed:0,unknown:0,tokenReportedCalls:0,reportedTokens:{}},enumerable:true});
    const g = groups[key]; g.invocations++; if (r.promptStarted) g.submittedPrompts++;
    if (r.status === 'passed') g.passed++; else if (r.status === 'failed') g.failed++; else if (['started','prompt_started','unknown'].includes(r.status)) g.unknown++;
    // Only independent one-prompt sessions can safely be summed here. Never sum context snapshots.
    if (r.usage?.accountingScope === 'fresh_session_single_prompt' && r.usage.tokens) {
      g.tokenReportedCalls++;
      for (const k of ['inputTokens','outputTokens','totalTokens','cachedReadTokens','cachedWriteTokens','thoughtTokens']) {
        const n=r.usage.tokens[k];
        if (Number.isSafeInteger(n) && n>=0) g.reportedTokens[k]=(g.reportedTokens[k]??0)+n;
      }
    }
  }
  return { at:new Date().toISOString(), source:'local_agy_invocations_only', groups,
    internalModelRequests:null, subscriptionRemaining:null,
    note:'Reported tokens only; missing values are unknown. ACP prompts are not internal LLM request counts. Context and account quotas are separate.' };
}
