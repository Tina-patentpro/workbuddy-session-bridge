'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {spawn,spawnSync}=require('node:child_process');
const {TextDecoder}=require('node:util');
const {createCliStream,createCliInitStream,CAPS}=require('../lib/managed/adapters/cli-stream');
const {createOfflineInitSandboxConfig,readSandboxFileIdentity}=require('../lib/managed/adapters/cli-init-sandbox');
const {createObservationBudget,createCallbackBudget}=require('../lib/managed/adapters/cli-probe-budget');
const {remainingInitMs,requireInitDeadline}=require('../lib/managed/adapters/cli-init-clock');
const {FAKE_ENTRY,SCENARIOS,INIT_FAKE_ENTRY,INIT_PROFILE,INIT_SCENARIOS,hash,privateDir,openEvidence,writeJson,readJson,syncDir}=require('./cli-feasibility-probe');

function supervise() {
  let token,intent,child,parser,watch,killTimer,stopAt,killAt,leaseUntil,logFd,observations,outFd,errFd,parsedFd;
  const callbacks=createCallbackBudget();
  let armed=false,started=false,submitted=false,done=false,stopReason=null,problem=null,childPid=null,stopAttempted=false;
  let stdoutReceived=0,stderrReceived=0,stdoutSaved=0,stderrSaved=0,parsedSaved=0,truncated=false;
  let evidenceGap=false,initMode=false,sandboxRuntime,sandboxConfigReceipt;
  const evidenceErrors=[],captured=new Map(),failedChannels=new Set();
  const stdoutHash=crypto.createHash('sha256'),stderrHash=crypto.createHash('sha256'),parsedHash=crypto.createHash('sha256');
  let node=process.execPath,instanceId=crypto.randomUUID();
  const log=(kind,details={})=>observations.write(JSON.stringify({kind,...details,at:Date.now(),instanceId,sourceId:intent.sourceId})+'\n');
  function gap(error,phase) {
    const code=typeof error?.code==='string'?error.code:'EVIDENCE_IO_FAILED';
    evidenceGap=true;problem=problem||code;
    if(evidenceErrors.length<16)evidenceErrors.push({phase,code});
  }
  function safeLog(kind,details={}) {try{log(kind,details);return true;}catch(e){gap(e,'log:'+kind);return false;}}
  const notify=(kind,extra={})=>{if(process.connected)process.send({kind,probeId:intent.probeId,attemptId:intent.attemptId,sourceId:intent.sourceId,...extra},()=>{});};
  const groupTerm=()=>{
    safeLog('owned_group_term_requested');
    try{process.kill(-process.pid,'SIGTERM');}catch(e){gap(e,'owned_group_term');}
  };
  function stop(reason) {
    if(done||stopAttempted)return;
    stopReason=stopReason||reason;stopAttempted=true;
    // Logging may fail on exactly the path that needs revocation. It never gates the signal.
    safeLog('stop_requested',{reason:stopReason});
    if(child)groupTerm();else finish(null,null);
  }
  function openCapture(name,cap) {
    const file=path.join(intent.evidenceDir,name);
    const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    captured.set(name,{fd,file,cap,initial:fs.fstatSync(fd)});return fd;
  }
  function writeCapture(name,raw) {
    try{fs.writeFileSync(captured.get(name).fd,raw);}
    catch(e){failedChannels.add(name);gap(e,'write:'+name);throw e;}
  }
  function readBack(name,expectedBytes,expectedHash) {
    const value=captured.get(name);
    if(!value){gap(null,'missing:'+name);return {savedBytes:null,sha256:null,identityStatus:'UNKNOWN',flushed:false};}
    const {fd,file,cap,initial}=value;
    let flushed=true;
    try{fs.fsyncSync(fd);}catch(e){flushed=false;gap(e,'flush:'+name);}
    let receipt;
    try{
      const a=fs.fstatSync(fd),at=fs.lstatSync(file);
      if(!a.isFile()||a.nlink!==1||(a.mode&0o077)||(process.getuid&&a.uid!==process.getuid())||
        a.dev!==initial.dev||a.ino!==initial.ino||at.isSymbolicLink()||at.dev!==a.dev||at.ino!==a.ino||a.size>cap)
        throw Object.assign(Error(),{code:'EVIDENCE_IDENTITY_UNPROVEN'});
      const raw=Buffer.alloc(a.size);let offset=0;
      while(offset<raw.length){const count=fs.readSync(fd,raw,offset,raw.length-offset,offset);if(count<=0)throw Object.assign(Error(),{code:'EVIDENCE_READ_INCOMPLETE'});offset+=count;}
      const after=fs.fstatSync(fd),pathAfter=fs.lstatSync(file);
      if(a.dev!==after.dev||a.ino!==after.ino||a.size!==after.size||a.mtimeMs!==after.mtimeMs||a.ctimeMs!==after.ctimeMs||
        pathAfter.isSymbolicLink()||pathAfter.dev!==after.dev||pathAfter.ino!==after.ino||after.nlink!==1)
        throw Object.assign(Error(),{code:'EVIDENCE_CHANGED_DURING_READ'});
      const actualHash=hash(raw),matchesCapture=a.size===expectedBytes&&actualHash===expectedHash;
      if(!matchesCapture)gap({code:'EVIDENCE_CAPTURE_MISMATCH'},'readback:'+name);
      receipt={savedBytes:a.size,sha256:actualHash,identityStatus:'VERIFIED',flushed,matchesCapture};
    }catch(e){gap(e,'readback:'+name);receipt={savedBytes:null,sha256:null,identityStatus:'UNKNOWN',flushed};}
    finally{try{fs.closeSync(fd);}catch(e){gap(e,'close:'+name);}}
    return receipt;
  }
  function finish(code,signal) {
    if(done)return;done=true;clearInterval(watch);clearTimeout(killTimer);
    let parsed={execution:'dispatch_unknown',events:[]};
    try{parsed=parser.end();}catch(e){problem=problem||e.code;}
    const native={};
    for(const key of initMode?['sessionId','initialization','modelCheck','currentModelId','accountPresent']:['sessionId','model','usage'])if(Object.hasOwn(parsed,key))native[key]=parsed[key];
    const result=parsed.events.at(-1)?.value?.result;
    const previewRaw=Buffer.from(result===undefined?'':typeof result==='string'?result:JSON.stringify(result));
    let previewBytes=previewRaw.subarray(0,CAPS.previewBytes),preview='';
    while(previewBytes.length){try{preview=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(previewBytes);break;}catch{previewBytes=previewBytes.subarray(0,-1);}}
    const hashedOnly=digest=>({savedBytes:0,sha256:digest,identityStatus:'HASHED_OBSERVATION_ONLY',retention:'not_retained'});
    const stdoutDigest=stdoutHash.digest('hex'),stderrDigest=stderrHash.digest('hex');
    const stdout=initMode?hashedOnly(stdoutDigest):readBack('stdout.bin',stdoutSaved,stdoutDigest);
    const stderr=initMode?hashedOnly(stderrDigest):readBack('stderr.bin',stderrSaved,stderrDigest);
    const parsedDisk=readBack('parsed-events.jsonl',parsedSaved,parsedHash.digest('hex'));
    safeLog('direct_child_exit',{childPid,code,signal,stopReason});
    if(logFd!==undefined){try{fs.closeSync(logFd);}catch(e){gap(e,'close:supervisor-log');}}
    let execution='dispatch_unknown';
    if(!started)execution='not_sent';
    else if(!problem&&!evidenceGap&&!truncated&&submitted){
      if(initMode&&stopReason==='INIT_RESPONSE_OBSERVED') {
        if(parsed.initialization==='acknowledged')execution='init_observed';
        else if(parsed.initialization==='rejected')execution='init_rejected';
      }
      else if(parsed.execution==='permission_denied'&&(!stopReason||stopReason==='PERMISSION_DENIED'))execution='permission_denied';
      else if(!stopReason&&parsed.execution==='native_success')execution=code===0?'succeeded':'failed';
      else if(!stopReason&&parsed.execution==='native_failure')execution='failed';
    }
    try{
      const outcome={version:1,scope:'OFFLINE_FAKE_ONLY',probeId:intent.probeId,attemptId:intent.attemptId,sourceId:intent.sourceId,instanceId,
        ...(initMode?{protocol:'initialize'}:{}),
        ...(initMode?{isolation:{kind:intent.isolation.kind,...(sandboxRuntime?
          {runtime:sandboxRuntime,home:intent.isolation.home,scratch:intent.isolation.scratch,config:sandboxConfigReceipt,
            ...(intent.isolation.localProxy?{localProxy:true}:{})}:{})}}:{}),
        childPid,execution,nativeExecution:parsed.execution,lifecycle:started?'direct_child_exited':'not_started',exitCode:code,signal,stopReason,error:problem,
        dispatch:submitted?'stdin_submitted':started?'spawned_submission_unknown':'not_sent',cost:'UNKNOWN',native,
        supervisorBudget:{watchCallbacks:callbacks.snapshot().watch},
        preview,previewTruncated:previewRaw.length>previewBytes.length,
        source:{gaps:truncated||evidenceGap,truncated,parseComplete:!problem,...(initMode?{fullRawRetained:false}:{}),
          stdout:{receivedBytes:stdoutReceived,...stdout},stderr:{receivedBytes:stderrReceived,...stderr},
          parsedBytes:parsedDisk.savedBytes,parsed:parsedDisk,evidenceErrors}};
      writeJson(intent.outcomePath,outcome);
    }catch{/* Missing outcome is unknown; never replace it with a fabricated receipt. */}
    if(process.connected)process.disconnect();
  }
  function configure(message) {
    if(token||message.kind!=='configure'||typeof message.token!=='string'||! /^[a-f0-9]{64}$/.test(message.token))return;
    token=message.token;intent=message.intent;
    initMode=intent?.profileId===INIT_PROFILE;
    const entry=initMode?INIT_FAKE_ENTRY:FAKE_ENTRY,scenarios=initMode?INIT_SCENARIOS:SCENARIOS;
    if(process.platform==='win32'||intent?.scope!=='OFFLINE_FAKE_ONLY'||intent.entry!==entry||!scenarios.includes(intent.scenario)||
      (initMode&&intent.protocol!=='initialize')||(!initMode&&intent.profileId!=='adp1a-offline'))throw Error('OFFLINE_BINDING_REQUIRED');
    if(initMode&&!['none','codex-native'].includes(intent.isolation?.kind))throw Error('OFFLINE_BINDING_REQUIRED');
    privateDir(intent.evidenceDir);privateDir(intent.workspace);
    const saved=readJson(path.join(intent.evidenceDir,'intent.json'));
    if(JSON.stringify(saved)!==JSON.stringify(intent)||hash(fs.readFileSync(entry))!==intent.entrySha256||
      fs.realpathSync(node)!==intent.nodeRealpath||hash(fs.readFileSync(node))!==intent.nodeSha256)throw Error('START_IDENTITY_CHANGED');
    if(initMode&&intent.isolation.kind==='codex-native')sandboxRuntime=readSandboxFileIdentity(intent.isolation.runtime);
    const input=Buffer.from(message.inputBase64,'base64');
    if(input.length!==intent.inputBytes||hash(input)!==intent.inputSha256)throw Error('INPUT_IDENTITY_CHANGED');
    // OS-reported current group + this inherited IPC channel prove this helper owns the group.
    const group=spawnSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8',env:{}});
    if(group.status!==0||Number(group.stdout.trim())!==process.pid)throw Error('OWNED_GROUP_NOT_PROVEN');
    const now=performance.now(),remaining=intent.deadlineAt-Date.now();
    if(remaining<=100||remaining>30000)throw Error('DEADLINE_EXPIRED');
    killAt=now+remaining;stopAt=killAt-100;leaseUntil=now+intent.leaseMs;
    if(intent.outerClock){
      if(!initMode)throw Error('OFFLINE_BINDING_REQUIRED');
      requireInitDeadline(intent.outerClock,'spawn');
      stopAt=Math.min(stopAt,now+remainingInitMs(intent.outerClock,'term'));
      killAt=Math.min(killAt,now+remainingInitMs(intent.outerClock,'kill'));
    }
    logFd=openEvidence(path.join(intent.evidenceDir,'supervisor-observations.jsonl'));
    observations=createObservationBudget(logFd);
    if(!initMode){outFd=openCapture('stdout.bin',intent.limits.stdoutBytes||CAPS.stdoutBytes);errFd=openCapture('stderr.bin',CAPS.stderrBytes);}
    parsedFd=openCapture('parsed-events.jsonl',8*1024*1024);
    parser=initMode?createCliInitStream({requestId:intent.initRequestId,expectedModelId:intent.expectedModelId,...intent.limits}):createCliStream(intent.limits);
    let sandboxLaunch;
    if(sandboxRuntime) {
      privateDir(intent.coordinationRoot);privateDir(intent.evidenceRoot);
      const scratch=intent.isolation.scratch,home=path.join(intent.evidenceDir,'codex-home');
      fs.mkdirSync(scratch,{mode:0o700});fs.mkdirSync(home,{mode:0o700});
      privateDir(scratch);privateDir(home);syncDir(intent.workspace);syncDir(intent.evidenceDir);
      const raw=Buffer.from(createOfflineInitSandboxConfig({workspace:intent.workspace,scratch,coordinationRoot:intent.coordinationRoot,
        evidenceRoot:intent.evidenceRoot,nodeRealpath:intent.nodeRealpath,entry,localProxy:intent.isolation.localProxy===true,
        home:intent.isolation.home}));
      if(raw.length>16384||hash(raw)!==intent.isolation.configSha256)throw Object.assign(Error(),{code:'SANDBOX_CONFIG_IDENTITY_CHANGED'});
      openCapture('codex-home/config.toml',16384);writeCapture('codex-home/config.toml',raw);
      sandboxConfigReceipt=readBack('codex-home/config.toml',raw.length,hash(raw));syncDir(home);
      if(sandboxConfigReceipt.identityStatus!=='VERIFIED'||!sandboxConfigReceipt.flushed||!sandboxConfigReceipt.matchesCapture)
        throw Object.assign(Error(),{code:'SANDBOX_CONFIG_UNVERIFIED'});
      sandboxLaunch={command:sandboxRuntime.realpath,args:['sandbox','-P','wb-init-local-only','-C',intent.workspace,'--',node,entry,intent.scenario],
        env:{CODEX_HOME:home,HOME:intent.isolation.home,CODEBUDDY_CONFIG_DIR:scratch,TMPDIR:scratch,PATH:'/usr/bin:/bin'}};
    }
    process.on('SIGTERM',()=>stop('GROUP_TERM'));process.on('SIGINT',()=>stop('SIGNAL'));
    // Hard stop is independent of the bounded watch callback and failed logs.
    killTimer=setTimeout(()=>{
      if(!done){safeLog('group_kill_requested');process.kill(-process.pid,'SIGKILL');}
    },Math.max(0,killAt-performance.now()));
    watch=setInterval(()=>{
      if(!callbacks.take('watch')||callbacks.exhausted('watch')){
        clearInterval(watch);problem=problem||'WATCH_BUDGET_EXHAUSTED';stop('WATCH_BUDGET_EXHAUSTED');return;
      }
      const at=performance.now();
      if(at>=stopAt)stop('DEADLINE');else if(at>=leaseUntil)stop('OWNER_LEASE_EXPIRED');
    },10);
    if(!safeLog('armed',{helperPid:process.pid,deadlineAt:intent.deadlineAt})){stop('PREPARATION_FAILED');return;}
    armed=true;
    notify('armed',{instanceId});
    function capture(channel,chunk) {
      if(done)return;
      try{
        if(channel==='stdout'){
          stdoutReceived+=chunk.length;
          if(initMode)stdoutHash.update(chunk);
          else {
            if(failedChannels.has('stdout.bin'))return;
            const saved=chunk.subarray(0,Math.max(0,(intent.limits.stdoutBytes||CAPS.stdoutBytes)-stdoutSaved));
            writeCapture('stdout.bin',saved);stdoutHash.update(saved);stdoutSaved+=saved.length;
            if(saved.length<chunk.length){truncated=true;problem=problem||'STDOUT_CAP_EXCEEDED';stop('STREAM_ERROR');return;}
          }
          const events=parser.write(chunk);
          let initReplied=false;
          for(const event of events){
            const bytes=Buffer.from(JSON.stringify(event)+'\n');
            if(parsedSaved+bytes.length>8*1024*1024)throw Object.assign(Error(),{code:'PARSED_CAP_EXCEEDED'});
            if(!failedChannels.has('parsed-events.jsonl')){writeCapture('parsed-events.jsonl',bytes);parsedHash.update(bytes);parsedSaved+=bytes.length;}
            if(Array.isArray(event.value.permission_denials)&&event.value.permission_denials.length)stop('PERMISSION_DENIED');
            if(initMode&&event.value.type==='control_response')initReplied=true;
          }
          if(initReplied)stop('INIT_RESPONSE_OBSERVED');
        }else{
          stderrReceived+=chunk.length;
          if(initMode) {
            stderrHash.update(chunk);
            if(stderrReceived>CAPS.stderrBytes){truncated=true;problem=problem||'STDERR_CAP_EXCEEDED';stop('STREAM_ERROR');}
          } else {
            if(failedChannels.has('stderr.bin'))return;
            const saved=chunk.subarray(0,Math.max(0,CAPS.stderrBytes-stderrSaved));
            writeCapture('stderr.bin',saved);stderrHash.update(saved);stderrSaved+=saved.length;
            if(saved.length<chunk.length){truncated=true;problem=problem||'STDERR_CAP_EXCEEDED';stop('STREAM_ERROR');}
          }
        }
      }catch(e){evidenceGap=true;problem=problem||e.code||'EVIDENCE_WRITE_FAILED';stop('STREAM_ERROR');}
    }
    return ()=>{
      if(started||done||stopReason||performance.now()>=stopAt)return;
      // Pin the fixed offline program again at the actual spawn boundary.
      if(hash(fs.readFileSync(entry))!==intent.entrySha256){problem='START_IDENTITY_CHANGED';stop('IDENTITY_CHANGED');return;}
      if(sandboxRuntime) {
        readSandboxFileIdentity(sandboxRuntime);
        readSandboxFileIdentity({realpath:path.join(intent.evidenceDir,'codex-home','config.toml'),
          sha256:intent.isolation.configSha256,bytes:sandboxConfigReceipt.savedBytes});
      }
      if(!safeLog('spawn_intent')){stop('SPAWN_EVIDENCE_FAILED');return;}
      if(intent.outerClock)requireInitDeadline(intent.outerClock,'spawn');
      if(performance.now()>=stopAt){stop('DEADLINE');return;}
      if(performance.now()>=leaseUntil){stop('OWNER_LEASE_EXPIRED');return;}
      started=true;
      child=spawn(sandboxLaunch?sandboxLaunch.command:node,sandboxLaunch?sandboxLaunch.args:[entry,intent.scenario],
        {cwd:intent.workspace,env:sandboxLaunch?sandboxLaunch.env:{},shell:false,detached:false,stdio:['pipe','pipe','pipe']});
      childPid=child.pid;
      child.on('error',e=>{problem=e.code;stop('SPAWN_ERROR');});
      child.stdout.on('data',b=>capture('stdout',b));child.stderr.on('data',b=>capture('stderr',b));
      child.stdin.on('error',e=>{problem=problem||e.code;stop('STDIN_ERROR');});
      child.on('close',(code,signal)=>finish(code,signal));
      child.once('spawn',()=>{
        if(stopReason)return;
        if(!safeLog('stdin_submission_boundary',{childPid,inputSha256:intent.inputSha256})){stop('SUBMISSION_EVIDENCE_FAILED');return;}
        try{
          submitted=true;
          if(initMode)child.stdin.write(input,()=>notify('stdin_submitted',{childPid}));
          else child.stdin.end(input,()=>notify('stdin_submitted',{childPid}));
        }catch(e){gap(e,'stdin_submission');stop('STDIN_ERROR');}
      });
    };
  }
  let start;
  process.on('message',message=>{
    try{
      if(!token){start=configure(message);return;}
      if(!message||message.token!==token)return;
      if(message.kind==='start'&&armed)start?.();
      else if(message.kind==='renew'&&!done&&performance.now()<stopAt)leaseUntil=performance.now()+intent.leaseMs;
      else if(message.kind==='cancel')stop('CONTROLLER_CANCELLED');
    }catch(e){if(intent&&logFd!==undefined){gap(e,'supervisor_preparation');stop('PREPARATION_FAILED');}else{
      if(intent&&process.connected)notify('preparation_refused',{code:e.code||(/^[A-Z_]+$/.test(e.message)?e.message:'SUPERVISOR_PREPARATION_FAILED')});
      if(process.connected)process.disconnect();process.exitCode=1;
    }}
  });
  process.on('disconnect',()=>{if(!done&&armed)stop('OWNER_DISCONNECTED');});
}
if(require.main===module){if(process.send)supervise();else{process.stderr.write('Private owned IPC supervisor only; no live CLI entry.\n');process.exitCode=2;}}
