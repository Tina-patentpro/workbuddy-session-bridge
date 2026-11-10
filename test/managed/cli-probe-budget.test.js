'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createObservationBudget,createCallbackBudget}=require('../../lib/managed/adapters/cli-probe-budget');
const {runtime}=require('./fixtures/cli-probe-fault-runtime');

function output(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-budget-'));
  const file=path.join(root,'observations'),fd=fs.openSync(file,'wx',0o600);
  t.after(()=>{fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true});});
  return {file,fd};
}

// Removing the pre-write byte check would persist the rejected record.
test('observer rejects the entire UTF-8 record before exceeding 1MiB',t=>{
  const {file,fd}=output(t),writer=createObservationBudget(fd);
  writer.write('a'.repeat(1048573));
  assert.throws(()=>writer.write('\u4e2d\n'),{code:'OBSERVATION_CAP_EXCEEDED'});
  assert.equal(fs.statSync(file).size,1048573);
  assert.throws(()=>writer.write('x'),{code:'OBSERVATION_CHANNEL_CLOSED'});
  assert.equal(fs.statSync(file).size,1048573);
});

// Retrying after an ambiguous partial write would append to a damaged log.
test('observer never appends after a partially failed write',t=>{
  const {file,fd}=output(t),writer=createObservationBudget(fd),original=fs.writeFileSync;
  fs.writeFileSync=function(target,data,...args){
    if(target===fd){original.call(this,target,data.slice(0,7),...args);throw Object.assign(Error(),{code:'ENOSPC'});}
    return original.call(this,target,data,...args);
  };
  try{assert.throws(()=>writer.write('synthetic-observation\n'),{code:'ENOSPC'});}
  finally{fs.writeFileSync=original;}
  assert.throws(()=>writer.write('later\n'),{code:'OBSERVATION_CHANNEL_CLOSED'});
  assert.equal(fs.readFileSync(file,'utf8'),'synthet');
});

// Removing either gate would execute one more renewal/watch action.
for(const [kind,limit] of [['renew',280],['watch',7000]])test(kind+' stops actions at its fixed total',()=>{
  const counter=createCallbackBudget();let executed=0;
  for(let n=0;n<limit;n++)if(counter.take(kind))executed++;
  assert.equal(counter.take(kind),false);assert.equal(counter.take(kind),false);
  assert.equal(executed,limit);assert.equal(counter.snapshot()[kind],limit);
});

// Only an owned private code copy has shortened limits, to reach exhaustion quickly.
for(const kind of ['renew','watch'])test(kind+' exhaustion revokes the owned peer and leaves the task unknown',async t=>{
  const h=runtime(t,'budget-'+kind,{scenario:'hang',budgetTransform:raw=>raw.replace(kind+':'+(kind==='renew'?280:7000),kind+':10')});
  const r=await h.run(h.spec);
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'direct_child_exited');
  assert.equal(r.stopReason,kind==='renew'?'CONTROLLER_CANCELLED':'WATCH_BUDGET_EXHAUSTED');
  if(kind==='renew')assert.equal(r.controllerError,'RENEW_BUDGET_EXHAUSTED');
  else assert.equal(r.error,'WATCH_BUDGET_EXHAUSTED');
  assert.equal(kind==='renew'?r.controllerBudget.renewCallbacks:r.supervisorBudget.watchCallbacks,10);
  assert.throws(()=>process.kill(r.childPid,0),{code:'ESRCH'});
});

test('controller observation overflow prevents helper launch',async t=>{
  const h=runtime(t,'budget-controller-log',{budgetTransform:raw=>raw.replaceAll('1048576','1')});
  await assert.rejects(h.run(h.spec),{code:'OBSERVATION_CAP_EXCEEDED'});
  assert.equal(fs.statSync(h.file('controller-observations.jsonl')).size,0);
  assert.equal(fs.existsSync(h.file('supervisor-observations.jsonl')),false);
});

test('watch exhaustion cannot disarm KILL when the owned peer ignores TERM',async t=>{
  const h=runtime(t,'budget-watch-kill',{scenario:'ignore-term',
    budgetTransform:raw=>raw.replace('watch:7000','watch:10')});
  const r=await h.run(h.spec);
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.lifecycle,'unknown');
  assert.equal(r.error,'SUPERVISOR_EXIT_WITHOUT_OUTCOME');
  const log=fs.readFileSync(h.file('supervisor-observations.jsonl'),'utf8');
  assert.match(log,/WATCH_BUDGET_EXHAUSTED/);assert.match(log,/group_kill_requested/);
});

test('late controller log failure cannot release a helper-success reservation',async t=>{
  const h=runtime(t,'budget-late-log',{budgetTransform:raw=>raw.replace('const bytes=Buffer.byteLength(raw);',
    "if(raw.includes('\"kind\":\"helper_exit\"'))throw error('SYNTHETIC_CONTROLLER_IO');const bytes=Buffer.byteLength(raw);")});
  const r=await h.run(h.spec);
  assert.equal(r.execution,'dispatch_unknown');assert.equal(r.controllerError,'SYNTHETIC_CONTROLLER_IO');
  assert.equal(JSON.parse(fs.readFileSync(h.file('outcome.json'))).execution,'succeeded');
  await assert.rejects(h.run({...h.spec,probeId:'next-probe',attemptId:'next-attempt',businessTaskId:'next-business'}),{code:'PROFILE_BUSY'});
});

test('missing or mismatched controller receipt blocks reuse of a helper success',async t=>{
  for(const variant of ['missing','mismatch']){
    const h=runtime(t,'budget-receipt-'+variant),r=await h.run(h.spec);
    assert.equal(r.execution,'succeeded');
    const file=h.file('controller-result.json'),receipt=JSON.parse(fs.readFileSync(file));
    assert.equal(receipt.controllerEvidenceComplete,true);assert.equal(receipt.controllerError,null);
    if(variant==='missing')fs.unlinkSync(file);
    else fs.writeFileSync(file,JSON.stringify({...receipt,sourceId:'wrong-source'})+'\n');
    await assert.rejects(h.run({...h.spec,probeId:'next-probe',attemptId:'next-attempt',businessTaskId:'next-business'}),{code:'PROFILE_BUSY'});
  }
});

test('matching complete controller and helper receipts permit the next distinct business task',async t=>{
  const h=runtime(t,'budget-receipt-complete');
  assert.equal((await h.run(h.spec)).execution,'succeeded');
  assert.equal((await h.run({...h.spec,probeId:'next-probe',attemptId:'next-attempt',businessTaskId:'next-business'})).execution,'succeeded');
});
