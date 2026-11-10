'use strict';
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {fork}=require('node:child_process');
const {error}=require('./cli-stream');
const {createFreshInitClock,claimInitClock,elapsedInitMs,remainingInitMs}=require('./cli-init-clock');
const WORKER=path.resolve(__dirname,'../../../bin/cli-init-transaction-worker.js');

// Internal mechanism: caller must supply its own newly forked detached child.
// The public transaction below never accepts executable/argv/env overrides.
function watchOwnedInitTransaction(child,clock,binding={}) {
  elapsedInitMs(clock);
  const nonce=crypto.randomBytes(32).toString('hex');
  return new Promise(resolve=>{
    let phase=0,helperPid=null,completed=null,settled=false,stopping=null;
    const timers=[];
    function signal(pid,sig){if(pid)try{process.kill(-pid,sig);}catch{}}
    function result(complete,lifecycle,why){return {
      scope:'OFFLINE_FAKE_ONLY',execution:complete?completed.execution:'dispatch_unknown',
      probeId:binding.probeId,attemptId:binding.attemptId,
      transactionEvidenceComplete:complete,workerLifecycle:lifecycle,error:why||null,
      transactionClock:{...clock,elapsedMs:elapsedInitMs(clock)},
      ...(complete?{sourceId:completed.sourceId,digest:completed.digest,readbackSha256:completed.readbackSha256}:{}),
    };}
    function finish(complete,lifecycle,why){
      if(settled)return;settled=true;for(const t of timers)clearTimeout(t);
      child.removeListener('message',message);child.removeListener('error',failed);
      if(!complete){signal(helperPid,'SIGKILL');signal(child.pid,'SIGKILL');}
      if(child.connected)try{child.disconnect();}catch{}
      child.unref();resolve(result(complete,lifecycle,why));
    }
    function abort(why){
      if(stopping||settled)return;stopping=why;
      signal(helperPid,'SIGKILL');signal(child.pid,'SIGKILL');
      // close proves exit if observed; an unresponsive OS stays explicitly unknown.
      timers.push(setTimeout(()=>finish(false,'unknown',why),Math.max(0,Math.min(100,remainingInitMs(clock,'result')))));
    }
    function send(value){if(child.connected)child.send({...value,nonce},e=>{if(e)abort('TRANSACTION_IPC_FAILED');});}
    function message(m){
      if(settled||stopping)return;
      if(!m||m.nonce!==nonce)return abort('TRANSACTION_PROTOCOL_INVALID');
      if(m.kind==='prepared'&&phase===0){
        if(remainingInitMs(clock,'preflight')<=0)return abort('OUTER_PREFLIGHT_DEADLINE_EXPIRED');
        phase=1;
      }else if(m.kind==='helper_created'&&phase===1&&helperPid===null&&Number.isSafeInteger(m.pid)&&m.pid>1&&m.pid!==child.pid){
        if(remainingInitMs(clock,'spawn')<=0)return abort('OUTER_SPAWN_DEADLINE_EXPIRED');
        helperPid=m.pid;send({kind:'helper_registered',pid:m.pid});
      }else if(m.kind==='spawned'&&phase===1&&helperPid!==null){
        if(remainingInitMs(clock,'spawn')<=0)return abort('OUTER_SPAWN_DEADLINE_EXPIRED');
        phase=2;
      }else if(m.kind==='helper_closed'&&helperPid===m.pid){
        helperPid=null;
      }else if(m.kind==='exited'&&phase>=1&&phase<=2&&helperPid===null){
        if(remainingInitMs(clock,'exit')<=0)return abort('OUTER_EXIT_DEADLINE_EXPIRED');
        phase=3;
      }else if(m.kind==='complete'&&phase===3&&helperPid===null&&m.probeId===binding.probeId&&m.attemptId===binding.attemptId&&
        ['init_observed','init_rejected','failed','permission_denied'].includes(m.execution)&&
        m.transactionEvidenceComplete===true&&typeof m.sourceId==='string'&&/^[a-f0-9]{64}$/.test(m.digest)&&/^[a-f0-9]{64}$/.test(m.readbackSha256)){
        if(remainingInitMs(clock,'result')<=0)return abort('OUTER_RESULT_DEADLINE_EXPIRED');
        completed=m;
      }else if(m.kind==='failed')abort(/^[A-Z_]{1,80}$/.test(m.code)?m.code:'TRANSACTION_WORKER_FAILED');
      else abort('TRANSACTION_PROTOCOL_INVALID');
    }
    function failed(){abort('TRANSACTION_WORKER_FAILED');}
    child.on('message',message);child.on('error',failed);
    child.once('close',(code,signal)=>{
      const ok=!stopping&&completed&&code===0&&signal===null&&remainingInitMs(clock,'result')>0;
      finish(!!ok,'exited',ok?null:(stopping||'TRANSACTION_INCOMPLETE'));
    });
    for(const [name,check] of [['preflight',()=>phase<1],['spawn',()=>phase<2],['exit',()=>phase<3],['result',()=>true]]){
      timers.push(setTimeout(()=>{if(check())abort('OUTER_'+name.toUpperCase()+'_DEADLINE_EXPIRED');},Math.max(0,remainingInitMs(clock,name))));
    }
    timers.push(setTimeout(()=>signal(helperPid,'SIGTERM'),Math.max(0,remainingInitMs(clock,'term'))));
    timers.push(setTimeout(()=>signal(helperPid,'SIGKILL'),Math.max(0,remainingInitMs(clock,'kill'))));
    send({kind:'start',clock,...binding});
  });
}

async function runOfflineInitTransaction(spec,options={}) {
  if(spec?.mode!=='offline-fake'||spec.profileId!=='adp2-init-offline')throw error('LIVE_PROBE_DISABLED');
  if(Object.keys(options).some(k=>!['preflightManifest','initSandboxRuntime','initLocalProxy'].includes(k)))throw error('INVALID_TRANSACTION_OPTIONS');
  const clock=claimInitClock(createFreshInitClock());
  const child=fork(WORKER,[],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{TMPDIR:os.tmpdir()},execArgv:[]});
  return watchOwnedInitTransaction(child,clock,{probeId:spec.probeId,attemptId:spec.attemptId,spec,options});
}
module.exports={runOfflineInitTransaction,watchOwnedInitTransaction};
