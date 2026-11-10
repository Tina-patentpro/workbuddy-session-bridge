'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const fixture=path.join(__dirname,'fixtures/cli-probe-fake.js');
const harness=()=>require('../../bin/cli-feasibility-probe');
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
function setup(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'adp1a-fake-')));
  for(const name of ['domain','evidence','workspace'])fs.mkdirSync(path.join(root,name),{mode:0o700});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {mode:'offline-fake',probeId:'probe-a',attemptId:'attempt-a',businessTaskId:'synthetic-a',profileId:'adp1a-offline',
    coordinationRoot:path.join(root,'domain'),evidenceRoot:path.join(root,'evidence'),workspace:path.join(root,'workspace'),
    input:Buffer.from('\ufeff  合成\r\n\r\n '),scenario:'success',timeoutMs:3000,leaseMs:500};
}
function evidence(s,name){return path.join(s.evidenceRoot,s.probeId,name);}
async function until(fn,ms=4000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}
  assert.fail('Expected owned fixture observation before test deadline');
}
function notRunning(pid) {
  const r=spawnSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',env:{}});
  return !r.stdout.trim()||r.stdout.trim().startsWith('Z');
}

test('exact stdin raw pipes source identity and separate observations survive the fake run',async t=>{
  const s=setup(t);process.env.ADP1A_SENTINEL='not-for-child';
  t.after(()=>delete process.env.ADP1A_SENTINEL);
  const r=await harness().runProbe(s);
  assert.equal(r.execution,'succeeded');assert.equal(r.lifecycle,'direct_child_exited');
  assert.equal(r.scope,'OFFLINE_FAKE_ONLY');assert.equal(r.source.gaps,false);
  assert.equal(r.cost,'UNKNOWN');assert.equal(Object.hasOwn(r.native,'model'),false);
  assert.deepEqual(fs.readFileSync(evidence(s,'input.bin')),s.input);
  const raw=fs.readFileSync(evidence(s,'stdout.bin'));assert.equal(sha(raw),r.source.stdout.sha256);
  const parsed=fs.readFileSync(evidence(s,'parsed-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const echo=parsed.at(-1).value.result;
  assert.deepEqual(Buffer.from(echo.inputBase64,'base64'),s.input);
  assert.deepEqual(echo.argv,['success']);
  // macOS may inject this OS text-encoding key even when spawn receives env:{}.
  assert.deepEqual(echo.envKeys.filter(k=>process.platform!=='darwin'||k!=='__CF_USER_TEXT_ENCODING'),[]);
  assert.equal(echo.envKeys.includes('ADP1A_SENTINEL'),false);
  assert.equal(fs.statSync(evidence(s,'stdout.bin')).mode&0o777,0o600);
  assert.equal(fs.statSync(path.dirname(evidence(s,'stdout.bin'))).mode&0o777,0o700);
  const intent=JSON.parse(fs.readFileSync(evidence(s,'intent.json')));
  assert.equal(intent.inputSha256,sha(s.input));assert.ok(intent.sourceId);
  assert.ok(fs.readFileSync(evidence(s,'controller-observations.jsonl'),'utf8').includes('supervisor_armed'));
  assert.equal(fs.readFileSync(evidence(s,'supervisor-observations.jsonl'),'utf8').includes('ownerCapability'),false);
});

test('attempt marker rejects repeat and changed input without a second spawn',async t=>{
  const s=setup(t);await harness().runProbe(s);
  await assert.rejects(harness().runProbe(s),{code:'ATTEMPT_ALREADY_RESERVED'});
  await assert.rejects(harness().runProbe({...s,input:Buffer.from('changed')}),{code:'ATTEMPT_ALREADY_RESERVED'});
  assert.equal(fs.readdirSync(s.evidenceRoot).length,1);
});

test('preexisting lost-ACK intent is retained and never restarted',async t=>{
  const s=setup(t);
  fs.mkdirSync(path.join(s.coordinationRoot,'reservations'),{mode:0o700});
  fs.writeFileSync(path.join(s.coordinationRoot,'reservations',s.probeId+'.json'),JSON.stringify({probeId:s.probeId}),{mode:0o600});
  await assert.rejects(harness().runProbe(s),{code:'ATTEMPT_ALREADY_RESERVED'});
  assert.deepEqual(fs.readdirSync(s.evidenceRoot),[]);
});

test('concurrent processes in one admission domain cannot start overlapping workspace attempts',async t=>{
  const s=setup(t);s.scenario='hang';s.timeoutMs=1800;
  let submitted;const started=new Promise(r=>submitted=r);
  const first=harness().runProbe(s,{onObservation:e=>{if(e.kind==='stdin_submitted')submitted();}});
  await started;
  const next={...s,probeId:'probe-b',attemptId:'attempt-b',businessTaskId:'synthetic-b'};
  const config=path.join(path.dirname(s.workspace),'second.json');fs.writeFileSync(config,JSON.stringify({...next,input:undefined,inputBase64:s.input.toString('base64')}));
  const child=spawn(process.execPath,[fixture,'controller',config],{env:{TMPDIR:fs.realpathSync(os.tmpdir())},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  const exit=await new Promise(r=>child.on('close',r));assert.equal(exit,1);assert.match(stderr,/PROFILE_BUSY|ADMISSION_LOCKED/);
  await first;
  assert.equal(fs.existsSync(path.join(s.evidenceRoot,'probe-b')),false);
});

test('unknown native terminal preserves business reservation even after local exit',async t=>{
  const s=setup(t);s.scenario='no-result';const r=await harness().runProbe(s);
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'direct_child_exited');
  await assert.rejects(harness().runProbe({...s,probeId:'probe-b',attemptId:'attempt-b',businessTaskId:'synthetic-b'}),{code:'PROFILE_BUSY'});
});

test('native success cannot override error exit or permission denial',async t=>{
  for(const [scenario,want] of [['error-exit','failed'],['permission-denied','permission_denied']]) {
    const s=setup(t);s.scenario=scenario;const r=await harness().runProbe(s);assert.equal(r.execution,want);
  }
});

test('invalid source and stream caps preserve raw evidence and cannot return success',async t=>{
  for(const [scenario,code] of [['malformed','INVALID_UTF8'],['wrong-session','SESSION_MISMATCH'],['stdout-flood','STDOUT_CAP_EXCEEDED'],['stderr-flood','STDERR_CAP_EXCEEDED']]) {
    const s=setup(t);s.scenario=scenario;
    if(scenario==='stdout-flood')s.limits={stdoutBytes:4096};
    const r=await harness().runProbe(s);assert.equal(r.execution,'dispatch_unknown');assert.equal(r.error,code);
    assert.equal(fs.existsSync(evidence(s,'stdout.bin')),true);
    if(scenario==='stdout-flood')assert.ok(fs.statSync(evidence(s,'stdout.bin')).size<=4096);
    if(scenario==='stderr-flood')assert.ok(fs.statSync(evidence(s,'stderr.bin')).size<=262144);
  }
});

test('controller death still stops owned fake at its lease and leaves immutable attempt evidence',async t=>{
  const s=setup(t);s.scenario='hang';s.timeoutMs=3000;
  const config=path.join(path.dirname(s.workspace),'controller.json');fs.writeFileSync(config,JSON.stringify({...s,input:undefined,inputBase64:s.input.toString('base64')}));
  const child=spawn(process.execPath,[fixture,'controller',config],{env:{TMPDIR:fs.realpathSync(os.tmpdir())},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let text='';child.stdout.on('data',b=>text+=b);await until(()=>text.includes('submitted'));
  child.kill('SIGKILL');await new Promise(r=>child.on('close',r));
  const r=await until(()=>{try{return JSON.parse(fs.readFileSync(evidence(s,'outcome.json')));}catch{return null;}});
  assert.equal(r.stopReason,'OWNER_DISCONNECTED');assert.equal(r.execution,'dispatch_unknown');
  await until(()=>notRunning(r.childPid));
  await assert.rejects(harness().runProbe(s),{code:'ATTEMPT_ALREADY_RESERVED'});
});

test('deadline terminates only the owned fixture group including its child',async t=>{
  const s=setup(t);s.scenario='descendant';s.timeoutMs=900;
  const r=await harness().runProbe(s);assert.equal(r.stopReason,'DEADLINE');assert.equal(r.execution,'dispatch_unknown');
  const events=fs.readFileSync(evidence(s,'parsed-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const pid=events.find(e=>e.value.descendantPid)?.value.descendantPid;assert.ok(pid);
  await until(()=>notRunning(pid));await until(()=>notRunning(r.childPid));
});

test('forced group stop never fabricates a stop proof or clears unknown',async t=>{
  const s=setup(t);s.scenario='ignore-term';s.timeoutMs=700;
  const r=await harness().runProbe(s);assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'unknown');
  assert.equal(r.error,'SUPERVISOR_EXIT_WITHOUT_OUTCOME');
  assert.match(fs.readFileSync(evidence(s,'supervisor-observations.jsonl'),'utf8'),/group_kill_requested/);
});

test('unsafe paths unsupported live input and invalid UTF-8 refuse before process launch',async t=>{
  const s=setup(t);
  await assert.rejects(harness().runProbe({...s,mode:'live'}),{code:'LIVE_PROBE_DISABLED'});
  await assert.rejects(harness().runProbe({...s,cli:'/Applications/WorkBuddy.app'}),{code:'INVALID_PROBE_SPEC'});
  await assert.rejects(harness().runProbe({...s,input:Buffer.from([255])}),{code:'INVALID_INPUT_UTF8'});
  const link=path.join(path.dirname(s.workspace),'link');fs.symlinkSync(s.workspace,link);
  await assert.rejects(harness().runProbe({...s,workspace:link}),{code:'UNSAFE_PROBE_PATH'});
  assert.deepEqual(fs.readdirSync(s.evidenceRoot),[]);
});

test('owned child crash without native terminal stays business unknown and blocks a new attempt',async t=>{
  const s=setup(t);s.scenario='hang';
  const r=await harness().runProbe(s,{onObservation:e=>{if(e.kind==='stdin_submitted')process.kill(e.childPid,'SIGKILL');}});
  assert.equal(r.signal,'SIGKILL');assert.equal(r.nativeExecution,'dispatch_unknown');
  assert.equal(r.execution,'dispatch_unknown');
  await assert.rejects(harness().runProbe({...s,probeId:'probe-b',attemptId:'attempt-b',businessTaskId:'synthetic-b'}),{code:'PROFILE_BUSY'});
});

test('observed native permission refusal stops a still-running fake before deadline',async t=>{
  const s=setup(t);s.scenario='denial-hang';
  const r=await harness().runProbe(s);
  assert.equal(r.nativeExecution,'permission_denied');assert.equal(r.stopReason,'PERMISSION_DENIED');
  assert.equal(r.execution,'permission_denied');assert.equal(r.lifecycle,'direct_child_exited');
});

test('parsed disk cap reports only bytes actually persisted',async t=>{
  const s=setup(t);s.scenario='parsed-flood';s.timeoutMs=10000;
  const r=await harness().runProbe(s);assert.equal(r.execution,'dispatch_unknown');assert.equal(r.error,'PARSED_CAP_EXCEEDED');
  const actual=fs.statSync(evidence(s,'parsed-events.jsonl')).size;
  assert.equal(r.source.parsedBytes,actual);assert.ok(actual<=8388608);
});
