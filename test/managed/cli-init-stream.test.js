'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createCliInitStream} = require('../../lib/managed/adapters/cli-stream');

const line = value => Buffer.from(JSON.stringify(value) + '\n');
function stream(limits = {}) {
  assert.equal(typeof createCliInitStream, 'function', 'init response receiver is missing');
  return createCliInitStream({requestId:'init-1', expectedModelId:'fixture-model', ...limits});
}
function ack(body = {}) {
  return {type:'control_response', response:{subtype:'success', request_id:'init-1', response:{
    commands:[{name:'fixture', description:'PRIVATE-COMMAND'}], output_style:'default',
    available_output_styles:['default'], models:[{id:'fixture-model', name:'fixture', description:'PRIVATE-MODEL-DESCRIPTION'}],
    currentModelId:'fixture-model', account:{token:'PRIVATE-TOKEN', enterpriseId:'PRIVATE-ENTERPRISE'}, ...body,
  }}};
}

test('init ACK is observed without a text result and does not invent execution cost or exit proof', () => {
  const s=stream(), raw=line(ack());
  for (const byte of raw) s.write(Buffer.from([byte]));
  const r=s.end();
  assert.equal(r.initialization,'acknowledged');
  assert.equal(r.modelCheck,'matched');
  assert.equal(r.currentModelId,'fixture-model');
  for (const key of ['execution','usage','cost','exitCode','stopped']) assert.equal(Object.hasOwn(r,key),false);
  assert.deepEqual(r.events,[{start:0,end:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex'),
    value:{type:'control_response',response:{subtype:'success',request_id:'init-1',modelIds:['fixture-model'],currentModelId:'fixture-model',accountPresent:true}}}]);
});

test('account presence distinguishes an omitted observation from null without retaining account data', () => {
  for (const [account,want] of [[{token:'PRIVATE-TOKEN',url:'PRIVATE-URL'},true],[null,false],[undefined,undefined]]) {
    const s=stream();s.write(line(ack({account})));const r=s.end();
    assert.equal(r.accountPresent,want);
    assert.equal(Object.hasOwn(r,'accountPresent'),want!==undefined);
    assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
  }
  const s=stream();assert.throws(()=>s.write(line(ack({account:'PRIVATE-INVALID'}))),{code:'INVALID_INIT_RESPONSE'});
});

test('account, unknown fields and error text never appear in returned events or exceptions', () => {
  const s=stream();
  const added=s.write(line({...ack({extra:'PRIVATE-EXTRA'}),extra:'PRIVATE-TOP'}));
  assert.doesNotMatch(JSON.stringify([added,s.end()]),/PRIVATE/);
  const failed=stream();
  failed.write(line({type:'control_response',response:{subtype:'error',request_id:'init-1',error:'PRIVATE-ERROR'}}));
  const r=failed.end();
  assert.equal(r.initialization,'rejected');
  assert.equal(r.modelCheck,'unreported');
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});

test('requested model is never substituted for missing, empty or different observed metadata', () => {
  for (const [body,want] of [
    [{currentModelId:undefined},'unreported'],
    [{models:[]},'unreported'],
    [{models:[{id:'other-model'}]},'mismatch'],
    [{currentModelId:'other-model'},'mismatch'],
  ]) {
    const s=stream();s.write(line(ack(body)));assert.equal(s.end().modelCheck,want);
  }
  const empty=stream().end();
  assert.equal(empty.initialization,'unreported');assert.equal(empty.modelCheck,'unreported');
  assert.equal(Object.hasOwn(empty,'currentModelId'),false);
});

test('unrelated responses, malformed success and text results cannot satisfy initialization', () => {
  const unrelated=ack();unrelated.response.request_id='other';
  for (const value of [unrelated,{type:'control_response',response:{subtype:'success',request_id:'init-1'}},
    {type:'result',subtype:'success',is_error:false,result:'PRIVATE-RESULT'},
    {type:'assistant',message:'PRIVATE-MESSAGE'}]) {
    const s=stream();
    assert.throws(()=>s.write(line(value)),error=>{
      assert.doesNotMatch(error.stack,/PRIVATE/);return true;
    });
    assert.throws(()=>s.end());
  }
});

test('duplicate ACK and conflicting session identity fail instead of overwriting observations', () => {
  const s=stream();s.write(line(ack()));
  assert.throws(()=>s.write(line(ack())),{code:'DUPLICATE_INIT_RESPONSE'});
  const sessions=stream();
  sessions.write(line({type:'system',subtype:'init',session_id:'one',model:'fixture-model',extra:'PRIVATE'}));
  assert.throws(()=>sessions.write(line({type:'system',subtype:'init',session_id:'two'})),{code:'SESSION_MISMATCH'});
});

test('system init identity and a conflicting model remain observed across the control ACK', () => {
  const s=stream();s.write(line({type:'system',subtype:'init',session_id:'session-1',model:'other-model',extra:'PRIVATE'}));
  s.write(line(ack()));const r=s.end();
  assert.equal(r.sessionId,'session-1');assert.equal(r.modelCheck,'mismatch');
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});

test('init receiver preserves byte limits, fatal UTF-8 and complete NDJSON framing', () => {
  const raw=line(ack());
  const exact=stream({eventBytes:raw.length-1,stdoutBytes:raw.length});exact.write(raw);
  assert.equal(exact.end().bytes,raw.length);
  for (const [options,input,code] of [
    [{eventBytes:raw.length-2},raw,'EVENT_CAP_EXCEEDED'],
    [{stdoutBytes:raw.length-1},raw,'STDOUT_CAP_EXCEEDED'],
    [{},Buffer.from([0xff,10]),'INVALID_UTF8'],
    [{},Buffer.from('{"type":"control_response"}'),'INCOMPLETE_EVENT'],
    [{},Buffer.from('PRIVATE-NOT-JSON\n'),'INVALID_EVENT'],
  ]) {
    const s=stream(options);assert.throws(()=>{s.write(input);s.end();},{code});
  }
});

test('caller mutation of returned observations cannot change model qualification evidence', () => {
  const s=stream(),added=s.write(line(ack({models:[]})));
  added[0].value.response.modelIds.push('fixture-model');
  added[0].value.response.subtype='error';
  const r=s.end();assert.equal(r.modelCheck,'unreported');
  assert.equal(r.events[0].value.response.subtype,'success');
  assert.deepEqual(r.events[0].value.response.modelIds,[]);
});
