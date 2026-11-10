'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {error}=require('./cli-stream');

// Trusted toolchain configuration, never a field in the external job spec.
function readSandboxFileIdentity({realpath,sha256,bytes}) {
  if(typeof realpath!=='string'||!path.isAbsolute(realpath)||! /^[a-f0-9]{64}$/.test(sha256)||
    !Number.isSafeInteger(bytes)||bytes<1)throw error('INVALID_SANDBOX_BINDING');
  if(fs.realpathSync(realpath)!==realpath)throw error('START_IDENTITY_CHANGED');
  const fd=fs.openSync(realpath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size!==bytes)throw error('START_IDENTITY_CHANGED');
    const digest=crypto.createHash('sha256'),chunk=Buffer.alloc(65536);let total=0;
    while(total<bytes) {
      const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,bytes-total),total);
      if(!count)throw error('START_IDENTITY_CHANGED');
      digest.update(chunk.subarray(0,count));total+=count;
    }
    const after=fs.fstatSync(fd),at=fs.lstatSync(realpath);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||
      before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||at.isSymbolicLink()||at.dev!==after.dev||at.ino!==after.ino||
      digest.digest('hex')!==sha256)throw error('START_IDENTITY_CHANGED');
    return {realpath,sha256,bytes};
  } finally {fs.closeSync(fd);}
}

// Canonical, disjoint owned roots come from the carrier's admission boundary.
// This profile qualifies the fixed offline peer only; it grants no account/app access.
function createOfflineInitSandboxConfig({workspace,scratch,coordinationRoot,evidenceRoot,nodeRealpath,entry,localProxy=false,home}) {
  const rules=[[':root','deny'],[':minimal','read'],[':slash_tmp','deny'],
    ['/System/Library/OpenSSL/openssl.cnf','read'],[nodeRealpath,'read'],[entry,'read'],
    [workspace,'read'],[scratch,'write'],[coordinationRoot,'deny'],[evidenceRoot,'deny']];
  // Keep these narrow denies even when a caller permits their parent directory.
  if(home!==undefined)for(const tail of [['diagnostics'],['logs','memwatch'],['logs','cli-memwatch.log']])
    rules.push([path.join(home,'.codebuddy',...tail),'deny']);
  return 'default_permissions = "wb-init-local-only"\n'+
    '[permissions.wb-init-local-only.filesystem]\n'+
    rules.map(([key,access])=>JSON.stringify(key)+' = '+JSON.stringify(access)+'\n').join('')+
    '[permissions.wb-init-local-only.network]\nenabled = '+localProxy+'\nallow_local_binding = false\n'+
    'dangerously_allow_all_unix_sockets = false\n'+(localProxy?
      'allow_upstream_proxy = false\nmode = "full"\n'+
      '[permissions.wb-init-local-only.network.domains]\n"127.0.0.1" = "allow"\n'+
      '[features]\nnetwork_proxy = true\n':'');
}

module.exports={createOfflineInitSandboxConfig,readSandboxFileIdentity};
