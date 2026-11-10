'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {runtime,partial,unreadable,logFailure,digest}=require('./fixtures/cli-probe-fault-runtime');
const rows=file=>fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
async function waitFor(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){const x=fn();if(x)return x;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected owned fake evidence before deadline');}
async function retainedUnknown(h,r){
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.source.gaps,true);
  await assert.rejects(h.run({...h.spec,probeId:'new-probe',attemptId:'new-attempt',businessTaskId:'new-business'}),{code:'PROFILE_BUSY'});
}
for(const channel of ['stdout.bin','stderr.bin','parsed-events.jsonl'])test('PF-01 partial '+channel+' binds actual persisted bytes and preserves gaps',async t=>{
  const fixture=channel==='stderr.bin'?"'use strict';process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('synthetic stderr bytes for partial failure');process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false})+'\\n');});":undefined;
  const h=runtime(t,'partial-'+channel.replaceAll('.','-'),{prefix:partial(channel),fixture});
  const r=await h.run(h.spec);await retainedUnknown(h,r);assert.equal(r.error,'ENOSPC');
  const raw=fs.readFileSync(h.file(channel));
  const saved=channel==='parsed-events.jsonl'?r.source.parsed:r.source[channel.split('.')[0]];
  assert.equal(saved.identityStatus,'VERIFIED');assert.equal(saved.savedBytes,raw.length);assert.equal(saved.sha256,digest(raw));
  if(channel==='parsed-events.jsonl')assert.equal(r.source.parsedBytes,raw.length);
});
for(const channel of ['stdout.bin','parsed-events.jsonl'])test('PF-01 unreadable '+channel+' has UNKNOWN identity rather than invented zero/hash',async t=>{
  const h=runtime(t,'read-failure-'+channel.replaceAll('.','-'),{prefix:unreadable(channel)});
  const r=await h.run(h.spec);await retainedUnknown(h,r);
  const saved=channel==='parsed-events.jsonl'?r.source.parsed:r.source.stdout;
  assert.equal(saved.identityStatus,'UNKNOWN');assert.equal(saved.savedBytes,null);assert.equal(saved.sha256,null);
  if(channel==='parsed-events.jsonl')assert.equal(r.source.parsedBytes,null);
});
for(const [kind,persistent] of [['stop_requested',false],['owned_group_term_requested',false],['stop_requested',true]])test('PF-02 '+kind+' failure '+(persistent?'persistent':'once')+' never blocks owned TERM',async t=>{
  const h=runtime(t,'stop-'+kind+'-'+persistent,{prefix:logFailure(kind,persistent),scenario:'denial-hang'});
  const r=await h.run(h.spec);
  assert.equal(r.signal,'SIGTERM');assert.equal(r.lifecycle,'direct_child_exited');assert.equal(r.stopReason,'PERMISSION_DENIED');
  assert.equal(r.nativeExecution,'permission_denied');await retainedUnknown(h,r);
  assert.equal(rows(h.file('supervisor-observations.jsonl')).some(e=>e.kind==='group_kill_requested'),false);
});
test('PF-02 owner disconnect with persistent stop-log failure still terminates the owned fake',async t=>{
  const h=runtime(t,'owner-disconnect-log-failure',{prefix:logFailure('stop_requested',true),scenario:'hang'});
  const cfg=path.join(h.root,'controller.json');fs.writeFileSync(cfg,JSON.stringify({...h.spec,input:undefined,inputBase64:h.spec.input.toString('base64')}),{mode:0o600});
  const controller=spawn(process.execPath,[path.join(h.code,'test/managed/fixtures/cli-probe-fake.js'),'controller',cfg],{env:{TMPDIR:fs.realpathSync(os.tmpdir())},stdio:['ignore','pipe','pipe']});
  const closed=new Promise(r=>controller.once('close',r));t.after(()=>{if(controller.exitCode===null&&controller.signalCode===null)controller.kill('SIGKILL');});
  let stdout='';controller.stdout.on('data',b=>stdout+=b);await waitFor(()=>stdout.includes('submitted'));
  controller.kill('SIGKILL');await closed;
  const r=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(h.file('outcome.json')));}catch{return null;}});
  assert.equal(r.signal,'SIGTERM');assert.equal(r.stopReason,'OWNER_DISCONNECTED');await retainedUnknown(h,r);
});
test('PF-02 stdin-boundary log failure revokes the spawned fake without losing supervision',async t=>{
  const h=runtime(t,'stdin-boundary-log-failure',{prefix:logFailure('stdin_submission_boundary',true),
    fixture:"'use strict';process.stdin.resume();setInterval(()=>{},100);"});
  const r=await h.run(h.spec);
  const owner=rows(h.file('controller-observations.jsonl')).find(e=>e.kind==='supervisor_armed');
  assert.ok(owner?.helperPid);
  // This group was freshly created by this test's controller and bound in its private observation.
  t.after(()=>{try{process.kill(-owner.helperPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}});
  assert.equal(r.signal,'SIGTERM');assert.equal(r.lifecycle,'direct_child_exited');
  assert.equal(r.stopReason,'SUBMISSION_EVIDENCE_FAILED');assert.equal(r.dispatch,'spawned_submission_unknown');
  await retainedUnknown(h,r);
  assert.throws(()=>process.kill(r.childPid,0),{code:'ESRCH'});
});
