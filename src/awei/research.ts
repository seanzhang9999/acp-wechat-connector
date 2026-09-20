import type { CodexRouter } from '../codex/router.js';
import type { ThreadSummary } from '../codex/client.js';

/** Request-local evidence. IDs and cursors are issued by the backend, never invented by the model. */
export class ResearchSession {
  private threads = new Map<string, ThreadSummary>();
  private anchors = new Map<string, { threadId: string; cursor: string }>();
  private sources = new Map<string, { title: string; threadId: string; turns: string[]; text: string }>();
  private pages = new Map<string, string | null>();
  constructor(private router: CodexRouter, private user: string) {}
  async search(query: string, more: boolean) {
    await this.router.assistantSearch(this.user, query, more, true);
    const candidates = this.router.assistantContext(this.user).candidates;
    for (const t of candidates) this.threads.set(t.id, { ...t });
    return { candidates, hasMore: this.router.assistantContext(this.user).hasMore,
      scope: '未归档会话正文检索；命中摘要不是完整对话。可扩展关键词，未找到不等于不存在。' };
  }
  private thread(ref?: string) {
    const c = this.router.assistantContext(this.user);
    const candidate = ref ? c.candidates.find(t => t.id === ref || String(t.number) === ref) : c.current;
    const t = candidate ?? (ref ? this.threads.get(ref) : undefined);
    if (!t) throw new Error('请先搜索得到真实会话 ID，或指定当前会话。');
    this.threads.set(t.id, t);
    return t;
  }
  async locate(ref: string, query: string, more: boolean) {
    const t = this.thread(ref), key = `match:${t.id}:${query}`;
    if (more && !this.pages.get(key)) throw new Error('没有下一页命中。');
    const page = await this.router.researchOccurrences(t.id, query, more ? this.pages.get(key)! : undefined);
    this.pages.set(key, page.nextCursor ?? null);
    return { threadId: t.id, matches: page.data.map(m => {
      const anchor = `M${this.anchors.size + 1}`;
      this.anchors.set(anchor, { threadId: t.id, cursor: m.turnCursor });
      return { anchor, snippet: m.snippet.slice(0, 1800), turnId: m.turnId };
    }), hasMore: !!page.nextCursor };
  }
  async read(ref: string | undefined, anchor: string | undefined, earlier: boolean, count: number) {
    const t = this.thread(ref), a = anchor ? this.anchors.get(anchor) : undefined;
    if (anchor && (!a || a.threadId !== t.id)) throw new Error('命中位置不属于该会话。');
    const key = `read:${t.id}`;
    if (earlier && (!this.pages.get(key) || anchor)) throw new Error('没有可继续读取的历史页，或不能同时指定命中位置。');
    const page = await this.router.researchTurns(t.id, a?.cursor ?? (earlier ? this.pages.get(key)! : undefined), count);
    this.pages.set(key, page.nextCursor ?? null);
    const chunks: string[] = [];
    for (const turn of [...page.data].reverse()) {
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const text = item.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
          if (text) chunks.push(`[轮次 ${turn.id}] 用户：${text}`);
        } else if (item.type === 'agentMessage' && item.phase !== 'commentary' && item.text) {
          chunks.push(`[轮次 ${turn.id}] 助手：${item.text}`);
        }
      }
    }
    const raw = chunks.join('\n\n');
    if (!raw) return { threadId: t.id, text: '本页没有可见文本。', hasMore: !!page.nextCursor };
    const source = `E${this.sources.size + 1}`;
    const value = { title: t.name || t.preview || '未命名', threadId: t.id, turns: page.data.map(t => t.id), text: raw.slice(0, 12000) };
    this.sources.set(source, value);
    return { source, ...value, truncated: raw.length > 12000, hasMore: !!page.nextCursor,
      scope: '只读到本页可见文本；命中锚点读取命中轮及更早轮次。需要后续决定时读取最近页。' };
  }
  answer(text: string, refs: string[]) {
    const unique = [...new Set(refs)];
    if (!unique.length || unique.some(id => !this.sources.has(id))) throw new Error('回答必须引用本次实际读取的来源编号。');
    // Do not accept model-authored references to evidence it never read.
    for (const match of text.matchAll(/\[(E\d+)\]/g)) if (!unique.includes(match[1])) throw new Error('正文引用与来源列表不一致。');
    return text + '\n\n依据（本次读取的片段）：\n' + unique.map(id => {
      const s = this.sources.get(id)!;
      return `[${id}] ${s.title.replace(/\s+/g, ' ').slice(0, 100)}\n会话 ${s.threadId}；轮次 ${s.turns.join('、')}`;
    }).join('\n');
  }
}
