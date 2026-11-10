'use strict';
const fs=require('node:fs');
const {error}=require('./cli-stream');

// Internal carrier limits, never supplied by an external job or a live profile.
function createObservationBudget(fd) {
  let charged=0,closed=false;
  return {write(raw) {
    if(closed)throw error('OBSERVATION_CHANNEL_CLOSED');
    const bytes=Buffer.byteLength(raw);
    if(charged+bytes>1048576){closed=true;throw error('OBSERVATION_CAP_EXCEEDED');}
    // Charge before I/O: a failed write can have persisted an unknown prefix.
    charged+=bytes;
    try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}
    catch(e){closed=true;throw e;}
  }};
}

function createCallbackBudget() {
  const counts={renew:0,watch:0},limits={renew:280,watch:7000};
  return {
    take(kind) {
      if(!Object.hasOwn(limits,kind))throw error('INVALID_CALLBACK_KIND');
      if(counts[kind]>=limits[kind])return false;
      counts[kind]++;return true;
    },
    exhausted:kind=>counts[kind]>=limits[kind],
    snapshot:()=>({...counts})
  };
}
module.exports={createObservationBudget,createCallbackBudget};
