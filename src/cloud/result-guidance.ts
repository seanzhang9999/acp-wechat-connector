interface ResultState {
 taskId: string;
 status: string;
 text: string;
 permissionsDenied: number;
 artifacts: string[];
}

/** Local interpretation of common executor outcomes; never executes text from agy. */
export function resultGuidance(result: ResultState): string {
 const {taskId,status,text,permissionsDenied,artifacts}=result;
 if(permissionsDenied){
  return '这轮操作遇到了工具授权，尚未完成。若要继续，我可以把下一条授权消息转给你，并接收你的“同意”或“不同意”。';
 }
 if(status==='cancelled')return '这轮已取消。已完成的操作及部分结果请看原文。';
 const tail=text.trim().split('\n').filter(line=>line.trim()).slice(-4).join('\n');
 const lastLine=tail.split('\n').at(-1)??'';
 if(/(?:要不要|是否|愿意|would you like).*[？?]$/i.test(lastLine)){
  return `agy 可能在等你决定是否继续。可用 /continue ${taskId} 同意 或 /continue ${taskId} 不同意，我会把你的选择交回这次会话。`;
 }
 if(/(?:请(?:你)?(?:确认|选择|提供|补充|告诉我)|需要你(?:确认|选择|提供|补充)|please (?:confirm|choose|provide|clarify)|(?:could|can) you (?:confirm|provide|choose|clarify))/i.test(tail)){
  return `agy 可能在等你的决定或补充。下面保留了原问法。你可以用 /continue ${taskId} 加上答复，我会把它交回这次会话。`;
 }
 if(artifacts.length){
  return `我找到了 ${artifacts.length} 个任务目录里的文件。用 /files ${taskId} 查看文件名，或用 /file ${taskId} 文件名 让我发给你。`;
 }
 if(status==='succeeded'&&!text.trim())return '这轮执行已结束，agy 没有返回文字结果。';
 if(status==='failed')return '这轮执行未完成。下面是 agy 返回的情况。';
 return '';
}
