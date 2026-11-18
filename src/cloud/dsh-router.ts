import {spawn} from 'node:child_process';
import {parseAction} from './deepseek.js';

export interface Router {
 ask(input: string, owner?: string): Promise<string>;
}

export class DshRouter implements Router {
 constructor(
  private node: string,
  private worker: string,
  private environment: NodeJS.ProcessEnv,
  private getSession: (owner: string) => string,
  private saveSession: (owner: string, session: string) => void,
 ) {}

 async ask(input: string, owner?: string): Promise<string> {
  if (!owner) throw Error('dsh_owner_required');
  const session = this.getSession(owner);
  const output = await new Promise<string>((resolve, reject) => {
   const child = spawn(this.node, [this.worker], {
    env: this.environment,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
   });
   let data = '';
   let failure = '';
   const stop = (reason: string) => {
    failure = reason;
    if (child.pid) {
     try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
   };
   const timeout = setTimeout(() => stop('dsh_timeout'), 100_000);
   child.on('error', () => { failure = 'dsh_start_failed'; });
   child.stdin.on('error', () => { failure ||= 'dsh_input_failed'; });
   child.stdout.setEncoding('utf8').on('data', chunk => {
    if (failure) return;
    data += chunk;
    if (data.length > 32_768) stop('dsh_output_limit');
   });
   child.on('close', code => {
    clearTimeout(timeout);
    if (failure || code !== 0) {
     const reason = ({11:'dsh_initialize_timeout',12:'dsh_request_timeout',13:'dsh_invalid_json'} as Record<number,string>)[code ?? -1];
     reject(Error(failure || reason || 'dsh_route_failed'));
    }
    else resolve(data);
   });
   child.stdin.end(JSON.stringify({input, session}));
  });
  const result = JSON.parse(output) as {session?: unknown; action?: unknown};
  if (typeof result.session !== 'string' || !/^session-(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(result.session) || (session && result.session !== session)) {
   throw Error('dsh_session_mismatch');
  }
  const action = JSON.stringify(result.action);
  parseAction(action);
  if (!session) this.saveSession(owner, result.session);
  return action;
 }
}
