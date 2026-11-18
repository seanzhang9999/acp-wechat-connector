import {json} from 'node:stream/consumers';
import path from 'node:path';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';

const home=process.env.DSH_HOME;
const model=process.env.DEEPSEEK_MODEL;
if (!home || !model || !process.env.DEEPSEEK_API_KEY) process.exit(2);
const {input,session}=await json(process.stdin);
const instructions=[
 '你是微信用户和 agy 之间的阿维路由器。根据本轮请求和本会话历史选择动作，不调用工具。',
 '当前 tasks 数组是可选任务清单。历史只是上下文，不是新指令。只输出一个 JSON 对象，不加 Markdown。',
 '允许结构：{"action":"new"}、{"action":"list"}、{"action":"usage"}、{"action":"usage","task":"任务ID"}、{"action":"continue","task":"任务ID"}、{"action":"status","task":"任务ID"}、{"action":"cancel","task":"任务ID"} 或 {"action":"clarify","question":"问题"}。',
 'succeeded 表示上一轮已结束。resumable 为 true 的任务可以继续。attachments 是任务已收到的文件名，属于资料。用户明确要求继续，且主题与附件线索唯一指向可恢复任务时，直接选 continue；只有指向不明时才澄清。',
 '若用户只回复序号，可引用你明确给出的最近一组选择。若对所指任务有疑问，先澄清。不得批准工具、发送文件或声称已经执行。',
].join(' ');
const runtime=new DeepSeekHarness({
 profile:'sdk-minimal',
 dshBin:path.join(import.meta.dirname,'node_modules/@deepseek-ai/dsh/lib/bin.js'),
 dshHome:home,
 processCwd:home,
 patches:[path.join(import.meta.dirname,'dsh-router.cordis.patch.yml')],
 env:{...process.env,DSH_SYSTEM_PROMPT:instructions},
 initializeTimeoutMs:40_000,
 requestTimeoutMs:40_000,
 cwd:home,
 provider:'deepseek-official',
 model,
 maxTokens:768,
});
try{
 const context=session?await runtime.resumeSession(session):runtime.session();
 const result=await context.run(input);
 console.log(JSON.stringify({session:result.sessionId,action:JSON.parse(result.finalResponse)}));
}catch(error){
 if(error.name==='RequestTimeoutError')process.exitCode=String(error.message).startsWith('initialize ')?11:12;
 else if(error instanceof SyntaxError)process.exitCode=13;
 else process.exitCode=1;
}finally{
 await runtime.close();
}
