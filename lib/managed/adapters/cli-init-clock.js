'use strict';
const {error}=require('./cli-stream');
const deadlines=Object.freeze({preflight:15000,spawn:25000,term:60000,kill:65000,exit:70000,result:90000});
const issued=new WeakMap();

// Trusted caller creates this before its first fresh R01 read. Not a job field.
function createFreshInitClock() {
  const handle=Object.freeze({});
  issued.set(handle,{used:false,snapshot:Object.freeze({version:1,t0Ns:process.hrtime.bigint().toString(),t0WallMs:Date.now()})});
  return handle;
}
// Private fixed transaction worker uses only its parent's owned IPC snapshot.
// Never consumed from a job/spec field; the outside owner enforces the same T0.
function adoptOwnedInitClock(snapshot) {
  elapsedInitMs(snapshot);requireInitDeadline(snapshot,'preflight');
  const handle=Object.freeze({});
  issued.set(handle,{used:false,snapshot:Object.freeze({...snapshot})});
  return handle;
}
function claimInitClock(handle) {
  const entry=issued.get(handle);
  if(!entry)throw error('INVALID_INIT_CLOCK');
  if(entry.used)throw error('INIT_CLOCK_ALREADY_USED');
  entry.used=true;return entry.snapshot;
}
function elapsedInitMs(snapshot) {
  if(!snapshot||snapshot.version!==1||!/^\d{1,30}$/.test(snapshot.t0Ns)||
    !Number.isSafeInteger(snapshot.t0WallMs)||Object.keys(snapshot).sort().join(',')!=='t0Ns,t0WallMs,version')throw error('INVALID_INIT_CLOCK');
  const delta=process.hrtime.bigint()-BigInt(snapshot.t0Ns);
  if(delta<0n)throw error('INVALID_INIT_CLOCK');
  return Number(delta)/1e6;
}
function remainingInitMs(snapshot,phase) {
  if(!Object.hasOwn(deadlines,phase))throw error('INVALID_INIT_CLOCK_PHASE');
  return Math.ceil(deadlines[phase]-elapsedInitMs(snapshot));
}
function requireInitDeadline(snapshot,phase) {
  if(remainingInitMs(snapshot,phase)<=0)throw error('OUTER_'+phase.toUpperCase()+'_DEADLINE_EXPIRED');
}
module.exports={createFreshInitClock,adoptOwnedInitClock,claimInitClock,elapsedInitMs,remainingInitMs,requireInitDeadline};
