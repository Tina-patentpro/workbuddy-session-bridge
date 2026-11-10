'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {fork}=require('node:child_process');
const probe=require('../../bin/cli-feasibility-probe');
const transactionPath='../../lib/managed/adapters/cli-init-transaction';
const fixture=path.join(__dirname,'fixtures/cli-transaction-fault.js');
const age=ms=>({version:1,t0Ns:(process.hrtime.bigint()-BigInt(ms)*1000000n).toString(),t0WallMs:Date.now()-ms});
function root(t){const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wb-transaction-')));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}

// Missing prewrite checking would create a record the existing reader refuses.
test('oversized metadata refuses before creating a file',t=>{
  const file=path.join(root(t),'record.json');
  assert.throws(()=>probe.writeJson(file,{text:'x'.repeat(1048576)}),{code:'PROBE_RECORD_CAP_EXCEEDED'});
  assert.equal(fs.existsSync(file),false);
});

test('metadata at the reader boundary remains independently readable',t=>{
  const file=path.join(root(t),'record.json'),value={text:'x'.repeat(1048564)};
  // {"text":""}\n is 12 bytes; exactly 1MiB remains supported.
  probe.writeJson(file,value);assert.equal(fs.statSync(file).size,1048576);
  assert.deepEqual(probe.readJson(file),value);
});

// Moving the deadline timer into the blocked worker would let the marker appear.
test('outside watchdog terminates synchronous preflight before its side effect',async t=>{
  const {watchOwnedInitTransaction}=require(transactionPath);
  const marker=path.join(root(t),'must-not-exist');
  const child=fork(fixture,['block',marker],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{}});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  const result=await watchOwnedInitTransaction(child,age(14800));
  assert.equal(result.execution,'dispatch_unknown');assert.equal(result.error,'OUTER_PREFLIGHT_DEADLINE_EXPIRED');
  assert.equal(result.transactionEvidenceComplete,false);assert.equal(fs.existsSync(marker),false);
  assert.equal(result.workerLifecycle,'exited');
});

test('outside watchdog refuses an incomplete or forged completion',async t=>{
  const {watchOwnedInitTransaction}=require(transactionPath);
  const child=fork(fixture,['forged'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{}});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  const result=await watchOwnedInitTransaction(child,age(0));
  assert.equal(result.transactionEvidenceComplete,false);assert.equal(result.execution,'dispatch_unknown');
});

test('outside watchdog kills blocked final persistence and keeps result unknown',async t=>{
  const {watchOwnedInitTransaction}=require(transactionPath),marker=path.join(root(t),'late-persistence');
  const child=fork(fixture,['persist',marker],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{}});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  // Advance only parent timers after the genuine child reaches blocked persistence.
  // The independent blocked-preflight test above also exercises real elapsed time.
  t.mock.timers.enable({apis:['setTimeout']});
  child.on('message',m=>{if(m.kind==='exited')queueMicrotask(()=>t.mock.timers.tick(90000));});
  const result=await watchOwnedInitTransaction(child,age(0));
  assert.equal(result.transactionEvidenceComplete,false);assert.equal(result.error,'OUTER_RESULT_DEADLINE_EXPIRED');
  assert.equal(fs.existsSync(marker),false);
});

test('manifest completion does not disable deadline during reservation fsync',async t=>{
  const {watchOwnedInitTransaction}=require(transactionPath);
  const {runtime}=require('./fixtures/cli-probe-fault-runtime');
  const r=runtime(t,'stall'),marker=path.join(r.root,'late-reservation');
  const base=path.resolve(__dirname,'../..'),worker=path.join(r.code,'bin/cli-init-transaction-worker.js');
  fs.copyFileSync(path.join(base,'bin/cli-init-transaction-worker.js'),worker);
  const controller=path.join(r.code,'bin/cli-feasibility-probe.js');
  const prefix=`const stallFs=require('node:fs'),stallOpen=stallFs.openSync,stallSync=stallFs.fsyncSync,stallPaths=new Map();
stallFs.openSync=function(file,...args){const fd=stallOpen.call(this,file,...args);stallPaths.set(fd,file);return fd;};
stallFs.fsyncSync=function(fd){if(String(stallPaths.get(fd)).endsWith('/reservations/stall.json')){
 const until=process.hrtime.bigint()+2000000000n;while(process.hrtime.bigint()<until){}
 stallFs.writeFileSync(${JSON.stringify(marker)},'late reservation');}return stallSync.call(this,fd);};\n`;
  fs.writeFileSync(controller,prefix+fs.readFileSync(controller,'utf8'));
  const entry=path.join(r.code,'test/managed/fixtures/cli-init-fake.js'),raw=fs.readFileSync(entry);
  const spec={...r.spec,profileId:'adp2-init-offline',scenario:'init-ack',initRequestId:'request',expectedModelId:'fixture-model'};delete spec.input;
  const child=fork(worker,[],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{TMPDIR:os.tmpdir()},execArgv:[]});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  const result=await watchOwnedInitTransaction(child,age(14000),{probeId:spec.probeId,attemptId:spec.attemptId,spec,
    options:{preflightManifest:[{realpath:entry,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex')}]}});
  assert.equal(result.error,'OUTER_PREFLIGHT_DEADLINE_EXPIRED');
  assert.equal(result.transactionEvidenceComplete,false);assert.equal(fs.existsSync(marker),false);
});

test('fixed transaction runs preflight, initialize and saved receipt readback',async t=>{
  const {runOfflineInitTransaction}=require(transactionPath),dir=root(t);
  const roots={};for(const k of ['coordinationRoot','evidenceRoot','workspace']){roots[k]=path.join(dir,k);fs.mkdirSync(roots[k],{mode:0o700});}
  const entry=probe.INIT_FAKE_ENTRY,raw=fs.readFileSync(entry);
  const result=await runOfflineInitTransaction({mode:'offline-fake',profileId:'adp2-init-offline',probeId:'txn',attemptId:'a1',businessTaskId:'task1',
    ...roots,scenario:'init-ack',initRequestId:'req1',expectedModelId:'fixture-model',timeoutMs:1000,leaseMs:750},
    {preflightManifest:[{realpath:entry,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex')}]});
  assert.equal(result.transactionEvidenceComplete,true,JSON.stringify(result));
  assert.equal(result.execution,'init_observed');assert.equal(result.workerLifecycle,'exited');
  const saved=probe.readJson(path.join(roots.evidenceRoot,'txn','transaction-worker-result.json'));
  assert.equal(saved.probeId,'txn');assert.equal(saved.transactionEvidenceComplete,true);
  // An inner success cannot silently release an externally supervised attempt.
  // Until an outer durable acceptance contract exists, retain its reservation.
  await assert.rejects(()=>probe.runProbe({mode:'offline-fake',profileId:'adp2-init-offline',probeId:'txn2',attemptId:'a2',businessTaskId:'task2',
    ...roots,scenario:'init-ack',initRequestId:'req2',expectedModelId:'fixture-model',timeoutMs:1000,leaseMs:750}),{code:'PROFILE_BUSY'});
});

test('real mode is refused before a transaction worker can launch',async()=>{
  const {runOfflineInitTransaction}=require(transactionPath);
  await assert.rejects(()=>runOfflineInitTransaction({mode:'real',profileId:'adp2-init-offline'},{}),{code:'LIVE_PROBE_DISABLED'});
});

test('oversized preflight manifest refuses before reserving or dispatching',async t=>{
  const {runOfflineInitTransaction}=require(transactionPath),dir=root(t);
  const result=await runOfflineInitTransaction({mode:'offline-fake',profileId:'adp2-init-offline',probeId:'over',attemptId:'a'},
    {preflightManifest:[{realpath:path.join(dir,'does-not-exist'),bytes:270814880,sha256:'0'.repeat(64)}]});
  assert.equal(result.error,'PREFLIGHT_CAP_EXCEEDED');assert.equal(result.transactionEvidenceComplete,false);
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('transaction does not accept an executable or environment override',async()=>{
  const {runOfflineInitTransaction}=require(transactionPath);
  await assert.rejects(()=>runOfflineInitTransaction({mode:'offline-fake',profileId:'adp2-init-offline'},
    {command:'/bin/echo',env:{}}),{code:'INVALID_TRANSACTION_OPTIONS'});
});
