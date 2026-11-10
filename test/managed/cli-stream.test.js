'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function stream(options) {
  return require('../../lib/managed/adapters/cli-stream').createCliStream(options);
}
const line = value => Buffer.from(JSON.stringify(value) + '\n');
const result = {type:'result', subtype:'success', is_error:false, result:'合成结果'};

test('native fields and UTF-8 survive single-byte pipe chunks without invented metadata', () => {
  const s=stream(), raw=line(result);
  for(const byte of raw)s.write(Buffer.from([byte]));
  const value=s.end();
  assert.equal(value.execution,'native_success');
  assert.deepEqual(value.events.map(e=>e.value),[result]);
  assert.equal(Object.hasOwn(value,'model'),false);
  assert.equal(Object.hasOwn(value,'usage'),false);
  assert.equal(Object.hasOwn(value,'sessionId'),false);
  assert.deepEqual(value.events.map(e=>[e.start,e.end]),[[0,raw.length]]);
});

test('only observed native session model and usage are exposed', () => {
  const s=stream();
  s.write(line({type:'system',session_id:'fake-s',model:'fake-m'}));
  s.write(line({...result,session_id:'fake-s',usage:{input_tokens:3}}));
  const r=s.end();assert.equal(r.sessionId,'fake-s');assert.equal(r.model,'fake-m');
  assert.deepEqual(r.usage,{input_tokens:3});
});

test('event byte cap accepts cap-1 and cap, rejects cap+1 across chunks', () => {
  for(const [bytes,accept] of [[63,true],[64,true],[65,false]]) {
    const raw=Buffer.from('{"type":"system","pad":"'+'x'.repeat(bytes-26)+'"}\n');
    assert.equal(raw.length-1,bytes);
    const s=stream({eventBytes:64});
    if(accept){s.write(raw.subarray(0,12));s.write(raw.subarray(12));s.write(line({type:'result',subtype:'success',is_error:false}));assert.equal(s.end().execution,'native_success');}
    else assert.throws(()=>{s.write(raw.subarray(0,12));s.write(raw.subarray(12));},{code:'EVENT_CAP_EXCEEDED'});
  }
});

test('stdout cap counts total raw bytes including newlines', () => {
  const raw=line(result);
  for(const [limit,accept] of [[raw.length-1,false],[raw.length,true],[raw.length+1,true]]) {
    const s=stream({stdoutBytes:limit});
    if(accept){s.write(raw);assert.equal(s.end().execution,'native_success');}
    else assert.throws(()=>s.write(raw),{code:'STDOUT_CAP_EXCEEDED'});
  }
});

test('invalid UTF-8 JSON and incomplete final lines never become success', () => {
  for(const [raw,code] of [[Buffer.from([0xff,10]),'INVALID_UTF8'],[Buffer.from('{oops}\n'),'INVALID_EVENT'],[Buffer.from('{"type":"result"}'),'INCOMPLETE_EVENT']]) {
    const s=stream();assert.throws(()=>{s.write(raw);s.end();},{code});
  }
});

test('exit-like text and zero or multiple native results are not success', () => {
  const s=stream();s.write(line({type:'assistant',text:'success result fake-m'}));
  assert.equal(s.end().execution,'dispatch_unknown');
  const twice=stream();twice.write(line(result));
  assert.throws(()=>twice.write(line(result)),{code:'EVENT_AFTER_RESULT'});
});

test('source session and model conflicts are refused instead of choosing a value', () => {
  for(const [field,code] of [['session_id','SESSION_MISMATCH'],['model','MODEL_MISMATCH']]) {
    const s=stream();s.write(line({type:'system',[field]:'one'}));
    assert.throws(()=>s.write(line({...result,[field]:'two'})),{code});
  }
});

test('permission denials and native error remain distinct from successful text', () => {
  const denied=stream();denied.write(line({...result,permission_denials:[{tool_name:'Bash'}]}));
  assert.equal(denied.end().execution,'permission_denied');
  const failed=stream();failed.write(line({...result,is_error:true,subtype:'error'}));
  assert.equal(failed.end().execution,'native_failure');
});
