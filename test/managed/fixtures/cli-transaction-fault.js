'use strict';
const fs=require('node:fs');
if(process.argv[2]==='block'){
  // Actual blocking work; no timer mock can make this worker responsive.
  const until=process.hrtime.bigint()+2000000000n;
  while(process.hrtime.bigint()<until){}
  fs.writeFileSync(process.argv[3],'late side effect');process.exit(0);
}else if(process.argv[2]==='forged'){
  process.send({kind:'complete',execution:'init_observed',transactionEvidenceComplete:true},()=>process.disconnect());
}else if(process.argv[2]==='persist'){
  let helper,nonce;
  const send=kind=>process.send({kind,nonce,pid:helper?.pid});
  process.on('message',m=>{
    if(m.kind==='start'){
      nonce=m.nonce;send('prepared');
      helper=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});
      helper.once('close',()=>{
        send('helper_closed');process.send({kind:'exited',nonce},()=>{
          const until=process.hrtime.bigint()+2000000000n;
          while(process.hrtime.bigint()<until){}
          fs.writeFileSync(process.argv[3],'late persistence');process.disconnect();
        });
      });
      send('helper_created');
    }else if(m.kind==='helper_registered'){
      send('spawned');helper.kill('SIGKILL');
    }
  });
}
