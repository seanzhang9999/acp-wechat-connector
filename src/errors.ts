import { randomUUID } from 'node:crypto';
export type ExecutionState = 'not_sent' | 'unknown' | 'started' | 'completed' | 'failed' | 'read_only';
export class OperationFailure extends Error {
  constructor(readonly state: ExecutionState, cause: unknown) { super('Bridge operation failed', { cause }); }
}
function details(error: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { message?: unknown; code?: unknown; data?: { details?: unknown }; cause?: unknown };
  return [e.message, e.code, e.data?.details].filter(v => typeof v === 'string' || typeof v === 'number').join(' ') + (e.cause ? ' ' + details(e.cause, depth + 1) : '');
}
function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:token|password|secret|authorization|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[URL]');
}
/** Execution status comes from the call site, never guessed from an error string. */
export function userError(error: unknown, state: ExecutionState, operation: string, log: (s: string) => void = console.warn): string {
  if (error instanceof OperationFailure) state = error.state;
  const raw = details(error), ref = randomUUID().slice(0, 8);
  let code = 'INTERNAL', reason = '服务返回了未识别的错误，具体原因需要查看日志。';
  let action = '请提供下方错误编号，便于排查。';
  if (/active writer|另一个 Codex 服务占用/i.test(raw)) {
    code = 'SESSION_BUSY'; reason = '会话由另一个 Codex 服务持有，当前连接不能接管。';
    action = '若是桌面占用：继续在电脑使用，或在微信发送 /acp codex quit，等待退出成功后再交接。';
  } else if (/unauthori[sz]ed|authentication|login|登录|认证|\b401\b/i.test(raw)) {
    code = 'AUTH'; reason = '服务的登录状态或认证失效。'; action = '请在电脑检查对应服务的登录状态，完成登录后再继续。';
  } else if (/forbidden|permission denied|\b403\b|权限不足/i.test(raw)) {
    code = 'PERMISSION'; reason = '当前账号没有完成操作所需的权限。'; action = '请检查目标资源权限和当前登录账号，不要重复提交相同操作。';
  } else if (/rate.?limit|\b429\b|quota|额度|限流/i.test(raw)) {
    code = 'LIMIT'; reason = '服务限流或可用额度不足。'; action = '请检查额度或稍后再继续。';
  } else if (/timeout|timed out|超时/i.test(raw)) {
    code = 'TIMEOUT'; reason = '等待服务响应超时。'; action = '请先查看会话最近内容和任务状态。';
  } else if (/connection|ECONN|EPIPE|ENOTFOUND|fetch failed|network|断开|连接.*关闭/i.test(raw)) {
    code = 'CONNECTION'; reason = '服务连接中断或网络不可用。'; action = '请检查电脑网络与对应服务是否运行。';
  } else if (/method not found|not supported|unsupported|不支持|未提供.*模式|-32601/i.test(raw)) {
    code = 'UNSUPPORTED'; reason = '当前服务不支持所需接口或能力。'; action = '请检查适配器与服务版本；也可使用原 /acp 命令支持的功能。';
  } else if (/not found|不存在|找不到|-32002/i.test(raw)) {
    code = 'NOT_FOUND'; reason = '目标会话或资源不存在，或者当前服务无法访问。'; action = '请刷新会话列表，再选择正确目标。';
  } else if (/编号|候选|用法|未知命令|没有下一页|没有可继续|没有对应|未选择|还没选择|正在释放|未结束|目标正在执行|未转发给业务会话|没有返回可用|JSON|Unexpected token/i.test(raw)) {
    code = 'REQUEST'; reason = redact(raw.replace(/^Bridge operation failed\s*/, '')).slice(0, 300); action = '请检查请求内容，必要时刷新候选列表，或使用 /acp help。';
  }
  const status = {
    not_sent: '本次请求未送入 agent 执行；没有自动重发。',
    unknown: '执行状态无法确认，任务可能已经开始或完成；不会自动重发。',
    started: '任务已被服务接受，最终结果或回执尚未确认；不会自动重发。',
    failed: '服务报告任务失败或中止，但可能已产生部分结果或操作；不会自动重发。',
    completed: 'Agent 已完成本轮，但回复或附件交付失败；不会重新执行任务。',
    read_only: '本次为阿维查询/理解请求，未转发给业务会话；部分查询可能已完成。',
  }[state];
  if (state === 'unknown' || state === 'started' || state === 'completed' || state === 'failed') action += ' 请先核对会话记录，避免重发导致重复执行。';
  else if (state === 'not_sent') action += ' 处理后可重新发送原消息。';
  log(`[bridge-error ${code}-${ref}] operation=${operation} state=${state} detail=${redact(raw).slice(0, 2000)}`);
  return `⚠️ ${operation}未完成\n原因：${reason}\n状态：${status}\n处理：${action}\n错误编号：${code}-${ref}`;
}
