import readline from 'node:readline';
const scenario = process.argv[2];
let model = 'test-default';
const config = () => [{id:'provider-model',name:'Model',category:'model',type:'select',currentValue:model,options:[{group:'partner',name:'Partner',options:[{value:'test-opus',name:'Test Opus'}]}]}];
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const m = JSON.parse(line);
 if (scenario === 'timeout') continue;
 if (m.method === 'initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false}}});
 if (m.method === 'session/new') send({id:m.id,result:{sessionId:'test-session',configOptions:config()}});
 if (m.method === 'session/set_config_option') {
   if (scenario !== 'wrong-model') model=m.params.value;
   send({id:m.id,result:{configOptions:config()}});
 }
 if (m.method === 'session/prompt') {
   if (scenario === 'exit') process.exit(2);
   if (scenario === 'permission') {
     send({id:'permission',method:'session/request_permission',params:{sessionId:'test-session',toolCall:{toolCallId:'t',title:'test',status:'pending'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]}});
     continue;
   }
   if (scenario === 'switch') {
     model='test-default';
     send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'config_option_update',configOptions:config()}}});
   }
   send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_PROBE_OK'}}}});
   send({id:m.id,result:{stopReason:'end_turn'}});
 }
 if (m.id === 'permission' && m.result) {
   if (m.result.outcome.outcome !== 'cancelled') process.exit(9);
   send({id:3,result:{stopReason:'end_turn'}});
 }
}
