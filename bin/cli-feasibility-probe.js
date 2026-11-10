'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {TextDecoder}=require('node:util');
const {CAPS,error}=require('../lib/managed/adapters/cli-stream');
const {createOfflineInitSandboxConfig,readSandboxFileIdentity}=require('../lib/managed/adapters/cli-init-sandbox');
const {createObservationBudget,createCallbackBudget}=require('../lib/managed/adapters/cli-probe-budget');
const {claimInitClock,elapsedInitMs,remainingInitMs,requireInitDeadline}=require('../lib/managed/adapters/cli-init-clock');

// Deliberately no generic/live executable option in the ADP-1A candidate.
const FAKE_ENTRY=path.resolve(__dirname,'../test/managed/fixtures/cli-probe-fake.js');
const INIT_FAKE_ENTRY=path.resolve(__dirname,'../test/managed/fixtures/cli-init-fake.js');
const INIT_PROFILE='adp2-init-offline';
const INIT_SCENARIOS=Object.freeze(['init-ack','init-error','init-hang','init-wrong-model','init-boundary']);
const SUPERVISOR=path.join(__dirname,'cli-probe-supervisor.js');
const SCENARIOS=Object.freeze(['success','no-result','error-exit','permission-denied','denial-hang','parsed-flood','hang','ignore-term','descendant','malformed','wrong-session','stdout-flood','stderr-flood']);
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
function syncDir(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function privateDir(value) {
  if(typeof value!=='string'||!path.isAbsolute(value))throw error('UNSAFE_PROBE_PATH');
  const resolved=fs.realpathSync(value),tmp=fs.realpathSync(os.tmpdir());
  const st=fs.lstatSync(value);
  if(resolved!==path.resolve(value)||st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o077)||
    (process.getuid&&st.uid!==process.getuid())||!resolved.startsWith(tmp+path.sep))throw error('UNSAFE_PROBE_PATH');
  return resolved;
}
function makePrivate(dir){fs.mkdirSync(dir,{mode:0o700});return privateDir(dir);}
function openEvidence(file){return fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}
function writeExclusive(file,raw){const fd=openEvidence(file);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));}
function writeJson(file,value){
  const raw=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(raw)>1024*1024)throw error('PROBE_RECORD_CAP_EXCEEDED');
  writeExclusive(file,raw);
}
function readJson(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const a=fs.fstatSync(fd);
    if(!a.isFile()||a.nlink!==1||a.size>1024*1024||(a.mode&0o077)||(process.getuid&&a.uid!==process.getuid()))throw error('UNSAFE_PROBE_RECORD');
    const raw=fs.readFileSync(fd,'utf8'),b=fs.fstatSync(fd),value=JSON.parse(raw);
    if(a.ino!==b.ino||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||raw!==JSON.stringify(value)+'\n')throw error('UNSAFE_PROBE_RECORD');
    return value;
  }finally{fs.closeSync(fd);}
}
function overlap(a,b){return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);}
function validate(spec) {
  if(spec?.mode!=='offline-fake')throw error('LIVE_PROBE_DISABLED');
  const init=spec.profileId===INIT_PROFILE;
  const fields=['mode','probeId','attemptId','businessTaskId','profileId','coordinationRoot','evidenceRoot','workspace','scenario','timeoutMs','leaseMs','limits',
    ...(init?['initRequestId','expectedModelId']:['input'])];
  if(Object.keys(spec).some(k=>!fields.includes(k)))throw error('INVALID_PROBE_SPEC');
  for(const key of ['probeId','attemptId','businessTaskId'])if(typeof spec[key]!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(spec[key]))throw error('INVALID_PROBE_SPEC');
  if(init) {
    if(!INIT_SCENARIOS.includes(spec.scenario)||typeof spec.initRequestId!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(spec.initRequestId)||
      typeof spec.expectedModelId!=='string'||!spec.expectedModelId||spec.expectedModelId.length>4096)throw error('INVALID_PROBE_SPEC');
  } else {
    if(spec.profileId!=='adp1a-offline'||!SCENARIOS.includes(spec.scenario))throw error('INVALID_PROBE_SPEC');
    if(!Buffer.isBuffer(spec.input)||spec.input.length>65536)throw error('INVALID_PROBE_SPEC');
    try{new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(spec.input);}catch{throw error('INVALID_INPUT_UTF8');}
  }
  if(!Number.isSafeInteger(spec.timeoutMs)||spec.timeoutMs<300||spec.timeoutMs>30000||!Number.isSafeInteger(spec.leaseMs)||spec.leaseMs<100||spec.leaseMs>1000)throw error('INVALID_PROBE_SPEC');
  for(const [key,value] of Object.entries(spec.limits||{}))if(!['eventBytes','stdoutBytes'].includes(key)||!Number.isSafeInteger(value)||value<1||value>CAPS[key])throw error('INVALID_STREAM_LIMIT');
  const roots=['coordinationRoot','evidenceRoot','workspace'].map(k=>privateDir(spec[k]));
  if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&overlap(a,b))))throw error('UNSAFE_PROBE_PATH');
}
function reserve(spec,sandboxRuntime,localProxy,outerClock,outerTransactionRequired) {
  const root=spec.coordinationRoot,lock=path.join(root,'admission.lock');
  try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw error('ADMISSION_LOCKED');throw e;}
  try{
    for(const name of ['reservations','attempts']){const dir=path.join(root,name);if(!fs.existsSync(dir))makePrivate(dir);else privateDir(dir);}
    const record=path.join(root,'reservations',spec.probeId+'.json'),attempt=path.join(root,'attempts',spec.attemptId+'.json');
    if(fs.existsSync(record)||fs.existsSync(attempt))throw error('ATTEMPT_ALREADY_RESERVED');
    for(const name of fs.readdirSync(path.join(root,'reservations'))){
      const old=readJson(path.join(root,'reservations',name));
      if(old.businessTaskId===spec.businessTaskId)throw error('BUSINESS_TASK_RESERVED');
      let released=false;
      try{const o=readJson(old.outcomePath);released=o.probeId===old.probeId&&o.attemptId===old.attemptId&&o.sourceId===old.sourceId&&
        o.lifecycle==='direct_child_exited'&&o.source?.gaps===false&&['succeeded','failed','permission_denied','init_observed','init_rejected'].includes(o.execution);
        if(released&&old.controllerReceiptRequired){
          const c=readJson(path.join(path.dirname(old.outcomePath),'controller-result.json'));
          released=c.probeId===old.probeId&&c.attemptId===old.attemptId&&c.sourceId===old.sourceId&&c.digest===old.digest&&
            c.execution===o.execution&&c.controllerEvidenceComplete===true&&c.controllerError===null;
        }
        // An inner receipt cannot establish the outside owner's timely acceptance.
        // No durable outer-release contract exists yet: keep this reservation.
        if(old.outerTransactionRequired)released=false;
      }catch{released=false;}
      if(!released&&(old.profileId===spec.profileId||overlap(old.workspace,spec.workspace)))throw error('PROFILE_BUSY');
    }
    const evidenceDir=path.join(spec.evidenceRoot,spec.probeId);
    const entry=spec.profileId===INIT_PROFILE?INIT_FAKE_ENTRY:FAKE_ENTRY;
    const frozen={version:1,scope:'OFFLINE_FAKE_ONLY',controllerReceiptRequired:true,probeId:spec.probeId,attemptId:spec.attemptId,businessTaskId:spec.businessTaskId,
      ...(outerTransactionRequired?{outerTransactionRequired:true}:{}),
      ...(outerClock?{outerClock}:{}),
      profileId:spec.profileId,workspace:spec.workspace,inputSha256:hash(spec.input),inputBytes:spec.input.length,
      entry,entrySha256:hash(fs.readFileSync(entry)),nodeRealpath:fs.realpathSync(process.execPath),nodeSha256:hash(fs.readFileSync(process.execPath)),
      ...(spec.profileId===INIT_PROFILE?{protocol:'initialize',initRequestId:spec.initRequestId,expectedModelId:spec.expectedModelId,
        coordinationRoot:root,evidenceRoot:spec.evidenceRoot,isolation:sandboxRuntime?
          {kind:'codex-native',runtime:sandboxRuntime,home:os.homedir(),scratch:path.join(spec.workspace,'.init-scratch-'+spec.attemptId),
            ...(localProxy?{localProxy:true}:{})}:{kind:'none'}}:{}),
      scenario:spec.scenario,limits:spec.limits||{},timeoutMs:spec.timeoutMs,leaseMs:spec.leaseMs,tempRoot:fs.realpathSync(os.tmpdir())};
    if(sandboxRuntime)frozen.isolation.configSha256=hash(Buffer.from(createOfflineInitSandboxConfig({workspace:spec.workspace,
      scratch:frozen.isolation.scratch,coordinationRoot:root,evidenceRoot:spec.evidenceRoot,nodeRealpath:frozen.nodeRealpath,entry,localProxy,
      home:frozen.isolation.home})));
    const intent={...frozen,digest:hash(Buffer.from(JSON.stringify(frozen))),sourceId:crypto.randomUUID(),createdAt:Date.now(),deadlineAt:Date.now()+spec.timeoutMs,
      evidenceDir,outcomePath:path.join(evidenceDir,'outcome.json'),dispatch:'not_sent'};
    if(outerClock)requireInitDeadline(outerClock,'preflight');
    // The durable marker deliberately survives every subsequent failure.
    writeJson(record,intent);writeJson(attempt,{probeId:spec.probeId,attemptId:spec.attemptId,digest:intent.digest});
    makePrivate(evidenceDir);writeJson(path.join(evidenceDir,'intent.json'),intent);writeExclusive(path.join(evidenceDir,'input.bin'),spec.input);
    return intent;
  }finally{fs.rmdirSync(lock);syncDir(root);}
}
async function runProbe(spec,{onObservation=()=>{},initSandboxRuntime,initLocalProxy=false,initAttemptClock,onHelperCreated=()=>{},onPreflightComplete=()=>{},outerTransactionRequired=false}={}) {
  const outerClock=initAttemptClock===undefined?undefined:claimInitClock(initAttemptClock);
  if(outerClock){requireInitDeadline(outerClock,'preflight');if(spec?.profileId!==INIT_PROFILE)throw error('INVALID_INIT_CLOCK');}
  validate(spec);
  if(typeof outerTransactionRequired!=='boolean'||(outerTransactionRequired&&(!outerClock||spec.profileId!==INIT_PROFILE)))throw error('INVALID_TRANSACTION_BINDING');
  if(typeof initLocalProxy!=='boolean'||(initLocalProxy&&initSandboxRuntime===undefined))throw error('INVALID_SANDBOX_BINDING');
  if(initSandboxRuntime!==undefined&&spec.profileId!==INIT_PROFILE)throw error('INVALID_SANDBOX_BINDING');
  const sandboxRuntime=initSandboxRuntime===undefined?undefined:readSandboxFileIdentity(initSandboxRuntime);
  if(spec.profileId===INIT_PROFILE)spec={...spec,input:Buffer.from(JSON.stringify({type:'control_request',request_id:spec.initRequestId,
    request:{subtype:'initialize',hooks:{},capabilities:{},hasPrompt:false}})+'\n')};
  const intent=reserve(spec,sandboxRuntime,initLocalProxy,outerClock,outerTransactionRequired),controllerFd=openEvidence(path.join(intent.evidenceDir,'controller-observations.jsonl'));
  const observations=createObservationBudget(controllerFd),callbacks=createCallbackBudget();
  const token=crypto.randomBytes(32).toString('hex');
  let helper,renew,exitTimer,controllerError=null;
  const observe=event=>{
    const safe={...event,probeId:intent.probeId,attemptId:intent.attemptId,sourceId:intent.sourceId,at:Date.now()};
    observations.write(JSON.stringify(safe)+'\n');onObservation(safe);
  };
  try{
    observe({kind:'intent_durable'});
    if(outerClock)requireInitDeadline(outerClock,'preflight');
    await onPreflightComplete();
    if(outerClock)requireInitDeadline(outerClock,'spawn');
    helper=spawn(process.execPath,[SUPERVISOR],{cwd:intent.workspace,env:{TMPDIR:intent.tempRoot},shell:false,detached:true,stdio:['ignore','ignore','ignore','ipc']});
    const send=message=>{if(helper.connected)helper.send({...message,token},e=>{if(e)controllerError=controllerError||e.code;});};
    helper.on('error',e=>{controllerError=e.code;});
    helper.on('message',message=>{
      if(!message||message.sourceId!==intent.sourceId||message.probeId!==intent.probeId||message.attemptId!==intent.attemptId)return;
      try{
        if(message.kind==='armed'){observe({kind:'supervisor_armed',helperPid:helper.pid,instanceId:message.instanceId});send({kind:'start'});}
        else if(message.kind==='stdin_submitted')observe({kind:'stdin_submitted',childPid:message.childPid});
        else if(message.kind==='preparation_refused')observe({kind:'preparation_refused',code:message.code});
      }catch(e){controllerError=e.code||'CONTROLLER_OBSERVATION_FAILED';send({kind:'cancel'});}
    });
    const closed=new Promise(resolve=>helper.once('close',(code,signal)=>resolve({code,signal})));
    // Trusted outer owner registers the actual child before it may configure/start.
    // A rejected registration leaves the durable reservation and no peer launch.
    try{await onHelperCreated(helper);}catch(e){
      helper.kill('SIGKILL');if(helper.connected)helper.disconnect();throw e;
    }
    send({kind:'configure',intent,inputBase64:spec.input.toString('base64')});
    renew=setInterval(()=>{
      if(!callbacks.take('renew')||callbacks.exhausted('renew')){
        clearInterval(renew);controllerError=controllerError||'RENEW_BUDGET_EXHAUSTED';send({kind:'cancel'});return;
      }
      send({kind:'renew'});
    },Math.max(20,Math.floor(spec.leaseMs/3)));
    const exit=await (outerClock?Promise.race([closed,new Promise(resolve=>{
      exitTimer=setTimeout(()=>resolve({code:null,signal:null,outerExitExpired:true}),Math.max(0,remainingInitMs(outerClock,'exit')));
    })]):closed);
    clearInterval(renew);clearTimeout(exitTimer);
    let outcome;
    try{
      if(exit.outerExitExpired)throw error('OUTER_EXIT_DEADLINE_EXPIRED');
      if(outerClock)requireInitDeadline(outerClock,'exit');
      outcome=readJson(intent.outcomePath);
      if(outcome.probeId!==intent.probeId||outcome.attemptId!==intent.attemptId||outcome.sourceId!==intent.sourceId)throw error('OUTCOME_IDENTITY_MISMATCH');
    }catch(e){outcome={scope:'OFFLINE_FAKE_ONLY',probeId:intent.probeId,attemptId:intent.attemptId,sourceId:intent.sourceId,
      execution:'dispatch_unknown',lifecycle:'unknown',error:['OUTCOME_IDENTITY_MISMATCH','OUTER_EXIT_DEADLINE_EXPIRED'].includes(e.code)?e.code:'SUPERVISOR_EXIT_WITHOUT_OUTCOME',helperExit:exit,cost:'UNKNOWN'};}
    if(exit.outerExitExpired){
      controllerError=controllerError||'OUTER_EXIT_DEADLINE_EXPIRED';
      // No false stop proof: disconnect revokes the owned helper, but exit is unproven.
      if(helper.connected)try{helper.disconnect();}catch{}
      helper.unref();
    }
    try{observe({kind:'helper_exit',helperPid:helper.pid,code:exit.code,signal:exit.signal,execution:outcome.execution,controllerError});}
    catch(e){controllerError=controllerError||e.code||'CONTROLLER_OBSERVATION_FAILED';}
    if(outerClock){
      try{requireInitDeadline(outerClock,'result');}catch(e){controllerError=controllerError||e.code;}
      outcome={...outcome,outerClock:{...outerClock,elapsedMs:elapsedInitMs(outerClock)}};
    }
    if(controllerError)outcome={...outcome,execution:'dispatch_unknown',controllerError};
    outcome={...outcome,controllerBudget:{renewCallbacks:callbacks.snapshot().renew}};
    // Do not rewrite the helper's receipt. Admission needs both independent results.
    try{writeJson(path.join(intent.evidenceDir,'controller-result.json'),{
      version:1,probeId:intent.probeId,attemptId:intent.attemptId,sourceId:intent.sourceId,digest:intent.digest,
      execution:outcome.execution,controllerEvidenceComplete:!controllerError,controllerError,
      renewCallbacks:callbacks.snapshot().renew});}
    catch(e){outcome={...outcome,execution:'dispatch_unknown',controllerError:controllerError||e.code||'CONTROLLER_RESULT_UNSAVED'};}
    return outcome;
  }finally{clearInterval(renew);clearTimeout(exitTimer);fs.closeSync(controllerFd);}
}
if(require.main===module){process.stderr.write('ADP-1A offline library only. Live CLI execution is disabled.\n');process.exitCode=2;}
module.exports={runProbe,FAKE_ENTRY,SCENARIOS,INIT_FAKE_ENTRY,INIT_PROFILE,INIT_SCENARIOS,hash,privateDir,openEvidence,writeJson,readJson,syncDir};
