'use strict';
// Test-only private copies and filesystem faults; never registered by a runtime entry.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const M=path.resolve(__dirname,'../../..');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
function runtime(t,id,{prefix='',fixture,initFixture,scenario='success',budgetTransform,clockTransform}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'adp1a-pf-'+id+'-')));
  const code=path.join(root,'code');
  const copied=[];
  for(const file of ['bin/cli-feasibility-probe.js','bin/cli-probe-supervisor.js','lib/managed/adapters/cli-stream.js',
    'lib/managed/adapters/cli-init-sandbox.js','lib/managed/adapters/cli-probe-budget.js','lib/managed/adapters/cli-init-clock.js',
    'test/managed/fixtures/cli-init-fake.js','test/managed/fixtures/cli-probe-fake.js']) {
    const p=path.join(code,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});
    fs.copyFileSync(path.join(M,file),p);copied.push({file,originalSha256:digest(fs.readFileSync(p))});
  }
  if(prefix){const p=path.join(code,'bin/cli-probe-supervisor.js');fs.writeFileSync(p,prefix+'\n'+fs.readFileSync(p,'utf8'));}
  if(fixture)fs.writeFileSync(path.join(code,'test/managed/fixtures/cli-probe-fake.js'),fixture);
  if(initFixture)fs.writeFileSync(path.join(code,'test/managed/fixtures/cli-init-fake.js'),initFixture);
  if(budgetTransform){const p=path.join(code,'lib/managed/adapters/cli-probe-budget.js');fs.writeFileSync(p,budgetTransform(fs.readFileSync(p,'utf8')));}
  if(clockTransform){const p=path.join(code,'lib/managed/adapters/cli-init-clock.js');fs.writeFileSync(p,clockTransform(fs.readFileSync(p,'utf8')));}
  for(const row of copied)row.executedSha256=digest(fs.readFileSync(path.join(code,row.file)));
  fs.writeFileSync(path.join(root,'copy-manifest.json'),JSON.stringify({scope:'LOCAL_FAKE_FILESYSTEM_FAULT_ONLY',copied},null,2)+'\n',{mode:0o600});
  for(const name of ['domain','evidence','workspace'])fs.mkdirSync(path.join(root,name),{mode:0o700});
  const spec={mode:'offline-fake',profileId:'adp1a-offline',probeId:id,attemptId:id+'-attempt',businessTaskId:id+'-business',
    coordinationRoot:root+'/domain',evidenceRoot:root+'/evidence',workspace:root+'/workspace',input:Buffer.from('\ufeff 合成\r\n '),scenario,timeoutMs:3500,leaseMs:500};
  t.after(()=>{
    const exportBase=process.env.ADP1A_FAULT_EVIDENCE_DIR;
    if(exportBase){
      fs.mkdirSync(exportBase,{recursive:true,mode:0o700});
      const target=path.join(exportBase,id);
      if(fs.existsSync(target))throw Error('Evidence export exists; use a new test-run output root');
      fs.cpSync(root,target,{recursive:true,preserveTimestamps:true});
      fs.writeFileSync(path.join(target,'original-root.txt'),root+'\n',{mode:0o600});
    }else fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,code,spec,run:require(path.join(code,'bin/cli-feasibility-probe.js')).runProbe,
    clock:require(path.join(code,'lib/managed/adapters/cli-init-clock.js')),
    file:name=>path.join(spec.evidenceRoot,spec.probeId,name)};
}
const tracked=`const pfFs=require('node:fs'),pfOpen=pfFs.openSync,pfFiles=new Map();
pfFs.openSync=function(...args){const fd=pfOpen.apply(this,args);if(typeof args[0]==='string')pfFiles.set(fd,args[0]);return fd;};`;
function partial(channel){return tracked+`
const pfWrite=pfFs.writeFileSync;let pfDone=false;
pfFs.writeFileSync=function(fd,data,...rest){if(!pfDone&&pfFiles.get(fd)?.endsWith('/'+${JSON.stringify(channel)})&&Buffer.isBuffer(data)&&data.length>7){pfDone=true;pfWrite.call(this,fd,data.subarray(0,7),...rest);throw Object.assign(Error('synthetic partial write'),{code:'ENOSPC'});}return pfWrite.call(this,fd,data,...rest);};`;}
function unreadable(channel){return tracked+`
const pfRead=pfFs.readSync;
pfFs.readSync=function(fd,...rest){if(pfFiles.get(fd)?.endsWith('/'+${JSON.stringify(channel)}))throw Object.assign(Error('synthetic readback failure'),{code:'EIO'});return pfRead.call(this,fd,...rest);};`;}
function logFailure(kind,persistent=false){return tracked+`
const pfWrite=pfFs.writeFileSync;let pfDone=false;
pfFs.writeFileSync=function(fd,data,...rest){if(pfFiles.get(fd)?.endsWith('/supervisor-observations.jsonl')&&typeof data==='string'&&
  ((!pfDone&&data.includes('"kind":'+JSON.stringify(${JSON.stringify(kind)})))||(${persistent}&&pfDone))){pfDone=true;throw Object.assign(Error('synthetic observer write failure'),{code:'ENOSPC'});}return pfWrite.call(this,fd,data,...rest);};`;}
module.exports={runtime,partial,unreadable,logFailure,digest};
