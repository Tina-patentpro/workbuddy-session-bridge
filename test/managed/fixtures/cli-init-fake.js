'use strict';
// Synthetic protocol peer only. Optional connect to its own native localhost proxy;
// no product imports, account access, external requests or tools.
const scenario=process.argv[2];
async function boundaryObserved() {
  const fs=require('node:fs'),path=require('node:path');
  try{fs.readFileSync(path.resolve(process.cwd(),'../protected-marker'));return false;}
  catch(e){if(!['EPERM','EACCES'].includes(e.code))return false;}
  fs.writeFileSync(path.join(process.env.TMPDIR,'peer-write'),'OK');
  const identity={pid:process.pid,ppid:process.ppid},proxyValue=process.env.HTTP_PROXY||process.env.http_proxy;
  identity.home=require('node:os').homedir();identity.cliConfigDir=process.env.CODEBUDDY_CONFIG_DIR;
  if(identity.cliConfigDir)fs.writeFileSync(path.join(identity.cliConfigDir,'cli-config-write'),'CONFIG');
  if(proxyValue) {
    const proxy=new URL(proxyValue);
    if(proxy.hostname!=='127.0.0.1')return false;
    identity.proxyHost=proxy.hostname;identity.proxyPort=Number(proxy.port);
    identity.proxyReachable=await new Promise(resolve=>{
      const socket=require('node:net').connect(identity.proxyPort,identity.proxyHost);
      const timeout=setTimeout(()=>{socket.destroy();resolve(false);},500);
      socket.once('connect',()=>{clearTimeout(timeout);socket.destroy();resolve(true);});
      socket.once('error',()=>{clearTimeout(timeout);resolve(false);});
    });
  }
  fs.writeFileSync(path.join(process.env.TMPDIR,'peer-identity.json'),JSON.stringify(identity));
  return !proxyValue||identity.proxyReachable;
}
const timer=setInterval(()=>{},1000);
let pending='',received=false,sent=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  pending+=chunk;
  const lf=pending.indexOf('\n');
  if(lf<0)return;
  if(received||lf!==pending.length-1)process.exit(31);
  received=true;
  let q;
  try{q=JSON.parse(pending.slice(0,lf));}catch{process.exit(31);}
  const r=q.request;
  if(q.type!=='control_request'||typeof q.request_id!=='string'||r?.subtype!=='initialize'||r.hasPrompt!==false||
    JSON.stringify(r.hooks)!=='{}'||JSON.stringify(r.capabilities)!=='{}'||Object.keys(r).length!==4)process.exit(31);
  pending='';
  if(scenario==='init-hang')return;
  setTimeout(async()=>{
    const model=scenario==='init-wrong-model'?'other-model':'fixture-model';
    process.stderr.write('PRIVATE-SENTINEL-STDERR\n');
    const rejected=scenario==='init-error'||(scenario==='init-boundary'&&!await boundaryObserved());
    const response=rejected?{subtype:'error',request_id:q.request_id,error:'PRIVATE-SENTINEL-ERROR'}:
      {subtype:'success',request_id:q.request_id,response:{currentModelId:model,models:[{id:model}],
        account:{token:'PRIVATE-SENTINEL-TOKEN'},commands:[{name:'PRIVATE-SENTINEL-COMMAND'}]}};
    sent=true;process.stdout.write(JSON.stringify({type:'control_response',response})+'\n');
  },20);
});
process.stdin.on('end',()=>{if(!sent)process.exit(41);clearInterval(timer);});
