'use strict';
// Fixed synthetic process. Never imports WorkBuddy, bridge services or account configuration.
const scenario=process.argv[2];
if(scenario==='controller') {
  const fs=require('node:fs');
  const {runProbe}=require('../../../bin/cli-feasibility-probe');
  const spec=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  spec.input=Buffer.from(spec.inputBase64,'base64');delete spec.inputBase64;
  runProbe(spec,{onObservation:event=>{if(event.kind==='stdin_submitted')process.stdout.write('submitted\n');}})
    .then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(e.code+'\n');process.exitCode=1;});
} else if(scenario==='descendant-child') {
  process.stdout.write(JSON.stringify({type:'system',descendantPid:process.pid})+'\n');
  setInterval(()=>{},100);
} else {
  const chunks=[];
  process.stdin.on('data',b=>chunks.push(b));
  process.stdin.on('end',()=>{
    const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
    const success={type:'result',subtype:'success',is_error:false,session_id:'offline-fake-session'};
    emit({type:'system',session_id:'offline-fake-session',pid:process.pid});
    if(scenario==='hang'||scenario==='ignore-term'||scenario==='descendant') {
      if(scenario==='ignore-term')process.on('SIGTERM',()=>{});
      if(scenario==='descendant')require('node:child_process').spawn(process.execPath,[__filename,'descendant-child'],{stdio:['ignore','inherit','inherit'],env:{}});
      setInterval(()=>{},100);return;
    }
    if(scenario==='no-result'){emit({type:'assistant',text:'success'});return;}
    if(scenario==='malformed'){process.stdout.write(Buffer.from([0xff,10]));return;}
    if(scenario==='stdout-flood'){for(let i=0;i<5000;i++)emit({type:'assistant',text:'x'.repeat(1000)});return;}
    if(scenario==='stderr-flood'){process.stderr.write(Buffer.alloc(262145,120));return;}
    if(scenario==='wrong-session'){emit({...success,session_id:'different'});return;}
    if(scenario==='permission-denied'||scenario==='denial-hang'){
      emit({...success,permission_denials:[{tool_name:'Bash'}]});
      if(scenario==='denial-hang')setInterval(()=>{},100);
      return;
    }
    if(scenario==='parsed-flood'){for(let i=0;i<70000;i++)emit({type:'assistant'});return;}
    emit({...success,result:{inputBase64:Buffer.concat(chunks).toString('base64'),argv:process.argv.slice(2),envKeys:Object.keys(process.env)}});
    if(scenario==='error-exit')process.exitCode=3;
  });
}
