'use strict';
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');

const CAPS = Object.freeze({eventBytes:65536, stdoutBytes:4194304, stderrBytes:262144, previewBytes:8192});
function error(code) { return Object.assign(new Error(code), {code}); }
function createEventStream(project, options = {}) {
  const limits={eventBytes:CAPS.eventBytes,stdoutBytes:CAPS.stdoutBytes,...options};
  for(const key of Object.keys(limits)) {
    if(!['eventBytes','stdoutBytes'].includes(key) || !Number.isSafeInteger(limits[key]) ||
       limits[key]<1 || limits[key]>CAPS[key])throw error('INVALID_STREAM_LIMIT');
  }
  const events=[];
  let pending=Buffer.alloc(0), total=0, offset=0, ended=false, poisoned=null;
  function refuse(code) { poisoned=error(code);throw poisoned; }
  function write(chunk) {
    if(poisoned)throw poisoned;
    if(ended)throw error('STREAM_CLOSED');
    if(!Buffer.isBuffer(chunk))throw error('INVALID_STREAM_CHUNK');
    total+=chunk.length;
    if(total>limits.stdoutBytes)refuse('STDOUT_CAP_EXCEEDED');
    pending=Buffer.concat([pending,chunk]);
    const added=[];
    while(true) {
      const lf=pending.indexOf(10);
      if(lf<0)break;
      if(lf>limits.eventBytes)refuse('EVENT_CAP_EXCEEDED');
      const raw=pending.subarray(0,lf), frame=pending.subarray(0,lf+1);
      let value,text;
      try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{refuse('INVALID_UTF8');}
      try{value=JSON.parse(text);}catch{refuse('INVALID_EVENT');}
      if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.type!=='string')refuse('INVALID_EVENT');
      let projected;
      try { projected=project(value); } catch (cause) { poisoned=cause;pending=Buffer.alloc(0);throw cause; }
      const event={start:offset,end:offset+frame.length,sha256:crypto.createHash('sha256').update(frame).digest('hex'),value:projected};
      events.push(event);added.push(event);
      offset+=frame.length;pending=pending.subarray(lf+1);
    }
    if(pending.length>limits.eventBytes)refuse('EVENT_CAP_EXCEEDED');
    return added;
  }
  function end() {
    if(poisoned)throw poisoned;
    if(pending.length)refuse('INCOMPLETE_EVENT');
    ended=true;
    return {events:structuredClone(events),bytes:total};
  }
  return {write,end};
}

function metadata(event,key,prior,code) {
  if(!Object.hasOwn(event,key))return prior;
  if(typeof event[key]!=='string'||!event[key]||event[key].length>4096)throw error('INVALID_EVENT');
  if(prior!==undefined&&prior!==event[key])throw error(code);
  return event[key];
}

function createCliStream(options = {}) {
  let terminal=null,sessionId,model;
  const stream=createEventStream(value=>{
    if(terminal)throw error('EVENT_AFTER_RESULT');
    sessionId=metadata(value,'session_id',sessionId,'SESSION_MISMATCH');
    model=metadata(value,'model',model,'MODEL_MISMATCH');
    if(value.type==='result')terminal=value;
    return value;
  },options);
  function end() {
    const captured=stream.end();
    let execution='dispatch_unknown';
    if(terminal) {
      if(Array.isArray(terminal.permission_denials)&&terminal.permission_denials.length)execution='permission_denied';
      else if(terminal.is_error===true)execution='native_failure';
      else if(terminal.subtype==='success'&&terminal.is_error===false)execution='native_success';
    }
    return {execution,...captured,
      ...(sessionId===undefined?{}:{sessionId}),...(model===undefined?{}:{model}),
      ...(terminal&&Object.hasOwn(terminal,'usage')?{usage:structuredClone(terminal.usage)}:{})};
  }
  return {write:stream.write,end};
}

// Receive-only init observations. An ACK proves neither model execution nor process exit.
// Project before retaining/returning events: initialize can contain account.token.
function createCliInitStream({requestId,expectedModelId,...limits} = {}) {
  if(typeof requestId!=='string'||!requestId||requestId.length>4096||
     typeof expectedModelId!=='string'||!expectedModelId||expectedModelId.length>4096)throw error('INVALID_INIT_BINDING');
  let initialization='unreported',currentModelId,sessionId,accountPresent,modelIds=[],modelMismatch=false;
  const stream=createEventStream(value=>{
    if(value.type==='system'&&value.subtype==='init') {
      sessionId=metadata(value,'session_id',sessionId,'SESSION_MISMATCH');
      const model=metadata(value,'model',undefined);
      if(model!==undefined&&model!==expectedModelId)modelMismatch=true;
      return {type:'system',subtype:'init',...(sessionId===undefined?{}:{session_id:sessionId}),
        ...(model===undefined?{}:{model})};
    }
    if(value.type!=='control_response')throw error('INIT_UNEXPECTED_EVENT');
    const response=value.response;
    if(!response||typeof response!=='object'||Array.isArray(response))throw error('INVALID_INIT_RESPONSE');
    if(response.request_id!==requestId)throw error('INIT_REQUEST_MISMATCH');
    if(initialization!=='unreported')throw error('DUPLICATE_INIT_RESPONSE');
    const projected={subtype:response.subtype,request_id:requestId};
    if(response.subtype==='error')initialization='rejected';
    else if(response.subtype==='success') {
      const body=response.response;
      if(!body||typeof body!=='object'||Array.isArray(body))throw error('INVALID_INIT_RESPONSE');
      currentModelId=metadata(body,'currentModelId',undefined);
      if(Object.hasOwn(body,'models')) {
        if(!Array.isArray(body.models))throw error('INVALID_INIT_RESPONSE');
        modelIds=body.models.map(model=>{
          if(!model||typeof model!=='object'||typeof model.id!=='string'||!model.id||model.id.length>4096)throw error('INVALID_INIT_RESPONSE');
          return model.id;
        });
        projected.modelIds=modelIds;
      }
      if(currentModelId!==undefined)projected.currentModelId=currentModelId;
      if(Object.hasOwn(body,'account')) {
        if(body.account!==null&&(typeof body.account!=='object'||Array.isArray(body.account)))throw error('INVALID_INIT_RESPONSE');
        projected.accountPresent=accountPresent=body.account!==null;
      }
      initialization='acknowledged';
    } else throw error('INVALID_INIT_RESPONSE');
    return {type:'control_response',response:projected};
  },limits);
  function end() {
    const captured=stream.end();
    const modelCheck=modelMismatch||(currentModelId!==undefined&&
      (currentModelId!==expectedModelId||(modelIds.length>0&&!modelIds.includes(currentModelId))))?'mismatch':
      initialization==='acknowledged'&&currentModelId===expectedModelId&&modelIds.includes(currentModelId)?'matched':'unreported';
    return {initialization,modelCheck,...captured,...(accountPresent===undefined?{}:{accountPresent}),
      ...(currentModelId===undefined?{}:{currentModelId}),...(sessionId===undefined?{}:{sessionId})};
  }
  return {write:chunk=>structuredClone(stream.write(chunk)),end};
}
module.exports={createCliStream,createCliInitStream,CAPS,error};
