'use strict';
const path=require('node:path');
const {runProbe,readJson,writeJson,hash}=require('./cli-feasibility-probe');
const {readSandboxFileIdentity}=require('../lib/managed/adapters/cli-init-sandbox');
const {adoptOwnedInitClock,requireInitDeadline}=require('../lib/managed/adapters/cli-init-clock');

// Fixed offline worker only; all potentially blocking disk work lives here.
if(require.main===module&&process.send){
  let started=false,nonce,registered;
  const send=(kind,value={})=>new Promise((resolve,reject)=>{
    if(!process.connected)return reject(Error('OWNER_DISCONNECTED'));
    process.send({kind,nonce,...value},e=>e?reject(e):resolve());
  });
  process.on('message',async m=>{
    if(started){if(m?.nonce===nonce&&m.kind==='helper_registered')registered?.(m.pid);return;}
    started=true;nonce=m?.nonce;
    try{
      if(m?.kind!=='start'||typeof nonce!=='string'||m.spec?.mode!=='offline-fake'||m.spec.profileId!=='adp2-init-offline')throw Error('OFFLINE_BINDING_REQUIRED');
      const handle=adoptOwnedInitClock(m.clock),manifest=m.options?.preflightManifest;
      if(!Array.isArray(manifest)||manifest.length===0||manifest.length>32)throw Error('PREFLIGHT_MANIFEST_INVALID');
      let bytes=0;
      for(const row of manifest){
        requireInitDeadline(m.clock,'preflight');
        if(!Number.isSafeInteger(row.bytes)||row.bytes<0||(bytes+=row.bytes)>167772160)throw Error('PREFLIGHT_CAP_EXCEEDED');
        readSandboxFileIdentity(row);
      }
      requireInitDeadline(m.clock,'preflight');
      const outcome=await runProbe(m.spec,{
        initAttemptClock:handle,outerTransactionRequired:true,initSandboxRuntime:m.options?.initSandboxRuntime,initLocalProxy:m.options?.initLocalProxy===true,
        onPreflightComplete:()=>send('prepared'),
        onHelperCreated:child=>new Promise((resolve,reject)=>{
          child.once('close',()=>{send('helper_closed',{pid:child.pid}).catch(()=>{});});
          registered=pid=>{if(pid===child.pid){registered=null;resolve();}};
          send('helper_created',{pid:child.pid}).catch(reject);
          process.once('disconnect',()=>reject(Error('OWNER_DISCONNECTED')));
        }),
        onObservation:event=>{if(event.kind==='stdin_submitted')send('spawned').catch(()=>{});},
      });
      requireInitDeadline(m.clock,'exit');await send('exited');
      const dir=path.join(m.spec.evidenceRoot,m.spec.probeId),intent=readJson(path.join(dir,'intent.json')),helper=readJson(path.join(dir,'outcome.json')),
        controller=readJson(path.join(dir,'controller-result.json'));
      if(helper.probeId!==m.spec.probeId||helper.attemptId!==m.spec.attemptId||helper.sourceId!==controller.sourceId||
        helper.probeId!==controller.probeId||helper.attemptId!==controller.attemptId||intent.digest!==controller.digest||
        intent.sourceId!==helper.sourceId||intent.probeId!==helper.probeId||intent.attemptId!==helper.attemptId||helper.source?.gaps!==false||
        outcome.execution!==controller.execution||helper.execution!==controller.execution||
        !controller.controllerEvidenceComplete||controller.controllerError!==null||helper.lifecycle!=='direct_child_exited')throw Error('TRANSACTION_RECEIPT_INCOMPLETE');
      requireInitDeadline(m.clock,'result');
      const receipt={version:1,scope:'OFFLINE_FAKE_ONLY',probeId:helper.probeId,attemptId:helper.attemptId,sourceId:helper.sourceId,digest:controller.digest,
        execution:controller.execution,transactionEvidenceComplete:true};
      const file=path.join(dir,'transaction-worker-result.json');writeJson(file,receipt);
      const saved=readJson(file);if(JSON.stringify(saved)!==JSON.stringify(receipt))throw Error('TRANSACTION_READBACK_MISMATCH');
      requireInitDeadline(m.clock,'result');await send('complete',{...receipt,readbackSha256:hash(Buffer.from(JSON.stringify(saved)+'\n'))});
      process.disconnect();
    }catch(e){
      const code=e.code||e.message;
      await send('failed',{code:/^[A-Z_]{1,80}$/.test(code)?code:'TRANSACTION_WORKER_FAILED'}).catch(()=>{});
      if(process.connected)process.disconnect();process.exitCode=1;
    }
  });
}else if(require.main===module){process.stderr.write('Private fixed offline transaction worker only.\n');process.exitCode=2;}
