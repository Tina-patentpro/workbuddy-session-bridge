'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createFreshInitClock,claimInitClock,remainingInitMs,requireInitDeadline}=require('../../lib/managed/adapters/cli-init-clock');
const {runtime}=require('./fixtures/cli-probe-fault-runtime');
function init(h){return {...h.spec,profileId:'adp2-init-offline',input:undefined,
  initRequestId:'clock-init',expectedModelId:'fixture-model',scenario:'init-ack'};}
function spec(h){const s=init(h);delete s.input;return s;}

test('fresh clock handles are one-use and cannot be fabricated from a serialized snapshot',()=>{
  const handle=createFreshInitClock(),snapshot=claimInitClock(handle);
  assert.ok(remainingInitMs(snapshot,'preflight')>14000);
  assert.throws(()=>claimInitClock(handle),{code:'INIT_CLOCK_ALREADY_USED'});
  assert.throws(()=>claimInitClock(snapshot),{code:'INVALID_INIT_CLOCK'});
});

test('all phases share the original monotonic T0 and ignore wall-clock rollback',t=>{
  let now=100000000000n;t.mock.method(process.hrtime,'bigint',()=>now);
  const snapshot=claimInitClock(createFreshInitClock());
  t.mock.method(Date,'now',()=>0);
  for(const [phase,ms] of [['preflight',15000],['spawn',25000],['term',60000],['kill',65000],['exit',70000],['result',90000]]){
    now=100000000000n+BigInt(ms-1)*1000000n;
    assert.equal(remainingInitMs(snapshot,phase),1);requireInitDeadline(snapshot,phase);
    now+=1000000n;
    assert.throws(()=>requireInitDeadline(snapshot,phase),{code:'OUTER_'+phase.toUpperCase()+'_DEADLINE_EXPIRED'});
  }
});

test('an already expired preflight refuses before any reservation or helper',async t=>{
  const h=runtime(t,'clock-expired'),s=spec(h);
  const clock=h.clock.createFreshInitClock();
  const original=process.hrtime.bigint;
  t.mock.method(process.hrtime,'bigint',()=>original()+16000000000n);
  await assert.rejects(h.run(s,{initAttemptClock:clock}),{code:'OUTER_PREFLIGHT_DEADLINE_EXPIRED'});
  assert.deepEqual(fs.readdirSync(s.coordinationRoot),[]);
  assert.deepEqual(fs.readdirSync(s.evidenceRoot),[]);
});

test('slow identity I/O consumes preflight time and cannot reset T0',async t=>{
  const h=runtime(t,'clock-slow-identity',{clockTransform:raw=>raw.replace('preflight:15000','preflight:200')}),s=spec(h);
  const original=fs.readFileSync;let delayed=false;
  t.mock.method(fs,'readFileSync',function(target,...args){
    if(target===process.execPath&&!delayed){delayed=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}
    return original.call(this,target,...args);
  });
  await assert.rejects(h.run(s,{initAttemptClock:h.clock.createFreshInitClock()}),{code:'OUTER_PREFLIGHT_DEADLINE_EXPIRED'});
  assert.equal(delayed,true);assert.equal(fs.existsSync(h.file('intent.json')),false);
  assert.equal(fs.existsSync(path.join(s.coordinationRoot,'reservations',s.probeId+'.json')),false);
});

test('a late spawn boundary never creates the helper and keeps the durable attempt',async t=>{
  const h=runtime(t,'clock-spawn',{clockTransform:raw=>raw.replace('spawn:25000','spawn:250')}),s=spec(h);
  await assert.rejects(h.run(s,{initAttemptClock:h.clock.createFreshInitClock(),onObservation:e=>{
    if(e.kind==='intent_durable')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,350);
  }}),{code:'OUTER_SPAWN_DEADLINE_EXPIRED'});
  assert.equal(fs.existsSync(h.file('supervisor-observations.jsonl')),false);
  assert.equal(fs.existsSync(path.join(s.coordinationRoot,'reservations',s.probeId+'.json')),true);
});

test('outer TERM tightens the fake deadline rather than resetting it after startup',async t=>{
  const h=runtime(t,'clock-term',{clockTransform:raw=>raw.replace('term:60000','term:1200').replace('kill:65000','kill:1600')}),s={...spec(h),scenario:'init-hang'};
  const r=await h.run(s,{initAttemptClock:h.clock.createFreshInitClock()});
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.stopReason,'DEADLINE');
  assert.equal(r.lifecycle,'direct_child_exited');assert.ok(r.outerClock.elapsedMs<3000);
});

test('late final observation cannot publish a complete controller result or release the profile',async t=>{
  const h=runtime(t,'clock-result',{clockTransform:raw=>raw.replace('result:90000','result:1000')}),s=spec(h);
  const r=await h.run(s,{initAttemptClock:h.clock.createFreshInitClock(),onObservation:e=>{
    if(e.kind==='helper_exit')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
  }});
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.controllerError,'OUTER_RESULT_DEADLINE_EXPIRED');
  assert.equal(JSON.parse(fs.readFileSync(h.file('controller-result.json'))).controllerEvidenceComplete,false);
  await assert.rejects(h.run({...s,probeId:'new-probe',attemptId:'new-attempt',businessTaskId:'new-business'}),{code:'PROFILE_BUSY'});
});

test('outer KILL remains independent when the init peer ignores TERM',async t=>{
  const h=runtime(t,'clock-kill',{initFixture:"process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},100);",
    clockTransform:raw=>raw.replace('term:60000','term:1200').replace('kill:65000','kill:1600')}),s={...spec(h),scenario:'init-hang'};
  const r=await h.run(s,{initAttemptClock:h.clock.createFreshInitClock()});
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'unknown');
  assert.equal(r.error,'SUPERVISOR_EXIT_WITHOUT_OUTCOME');assert.ok(r.outerClock.elapsedMs<2600);
  assert.match(fs.readFileSync(h.file('supervisor-observations.jsonl'),'utf8'),/group_kill_requested/);
});

test('exit boundary returns UNKNOWN without accepting a late helper receipt',async t=>{
  const h=runtime(t,'clock-exit',{prefix:'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1300);',
    clockTransform:raw=>raw.replace('exit:70000','exit:700')}),s=spec(h);
  const r=await h.run(s,{initAttemptClock:h.clock.createFreshInitClock()});
  const events=fs.readFileSync(h.file('controller-observations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const helper=events.find(e=>e.kind==='helper_exit')?.helperPid;
  assert.ok(helper,'unknown must identify the owned helper needing cleanup');
  t.after(()=>{try{process.kill(-helper,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}});
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'unknown');
  assert.equal(r.error,'OUTER_EXIT_DEADLINE_EXPIRED');
  assert.equal(JSON.parse(fs.readFileSync(h.file('controller-result.json'))).controllerEvidenceComplete,false);
});

test('an external job or serialized object cannot supply a fresh clock grant',async t=>{
  const h=runtime(t,'clock-forged'),s=spec(h);
  await assert.rejects(h.run({...s,outerClock:{version:1}}),{code:'INVALID_PROBE_SPEC'});
  await assert.rejects(h.run(s,{initAttemptClock:{version:1,t0Ns:'0',t0WallMs:0}}),{code:'INVALID_INIT_CLOCK'});
  assert.deepEqual(fs.readdirSync(s.coordinationRoot),[]);
});
