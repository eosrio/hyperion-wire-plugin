import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createProtocolProvider} from '../dist/provider.js';
import {createWireValueCodec,codecProfiles} from '../dist/index.js';
import {createWireCompiledAbiCache,createWireDeploymentRegistryCached} from '../dist/deployments.js';
const hex=b=>Buffer.from(b).toString('hex');
const handshake=JSON.parse(readFileSync(new URL('../fixtures/codec/ship.abi.json',import.meta.url)));
for(const profile of codecProfiles) test(`${profile.id}: exact ABI cache never adopts deployment authority or mutable ABI`,()=>{
 const provider=createProtocolProvider(profile.id),physical=createWireValueCodec(handshake,profile);
 const make=(tableId=0)=>({version:'sysio::abi/1.3',tables:[{name:'records',index_type:'',key_names:[],key_types:[],type:'uint64',table_id:tableId,secondary_indexes:[]}]});
 const abi=provider.contractCodec.decodeAbi(provider.contractCodec.encodeAbi(make())),abiHex=hex(provider.contractCodec.encodeAbi(abi));
 const deployment={id:'first',from:{blockNum:10,ordinal:2},until:{blockNum:10,ordinal:5},abi,abiHex};
 const ctx={chainId:'a'.repeat(64),blockId:'b'.repeat(64),blockNum:10,ordinal:2,abiDeployment:deployment};
 const row=['contract_row_kv_v0',{code:'contract',payer:'payer',table_id:0,key:'00',value:'ffffffffffffffff'}];const raw=physical.encode('contract_row_kv',row);const input={stream:'contract_row_kv',present:true,raw,value:physical.decode('contract_row_kv',raw)};
 const first=provider.normalizeDelta(input,ctx);assert.deepEqual(provider.normalizeDelta(input,ctx),first);
 assert.throws(()=>provider.normalizeDelta(input,{...ctx,ordinal:5}),/Missing ABI deployment/);
 assert.throws(()=>provider.normalizeDelta(input,{...ctx,abiDeployment:{...deployment,from:{blockNum:11,ordinal:0}}}),/Empty deployment interval/);
 assert.throws(()=>provider.normalizeDelta(input,{...ctx,chainId:'not-a-chain'}));
 assert.throws(()=>provider.normalizeDelta({...input,value:[row[0],{...row[1],key:'01'}]},ctx),/does not match/);
 assert.throws(()=>provider.normalizeDelta(input,{...ctx,abiDeployment:{...deployment,abi:make(1)}}),/does not match/);
 assert.throws(()=>provider.normalizeDelta(input,{...ctx,abiDeployment:{...deployment,abiHex:'00'}}));
 const second=provider.normalizeDelta(input,{...ctx,blockId:'c'.repeat(64),abiDeployment:{...deployment,id:'second'}});assert.equal(second.source.abiDeployment,'second');assert.equal(second.source.blockId,'c'.repeat(64));
 // Exceed the eight-entry bound with distinct valid ABIs, then revisit the first.
 for(let i=0;i<10;i++) { const changed=make();changed.tables[0].name='records'+i;
  const encoded=provider.contractCodec.encodeAbi(changed);const view=provider.contractCodec.decodeAbi(encoded);
  const result=provider.normalizeDelta(input,{...ctx,abiDeployment:{...deployment,abi:view,abiHex:hex(encoded)}});
  assert.equal(result.tableName,'records'+i);
 }
 assert.deepEqual(provider.normalizeDelta(input,ctx),first);
 const cache=createWireCompiledAbiCache(),item=cache.get(abiHex,profile.id);assert(Object.isFrozen(item.abi));assert(Object.isFrozen(item.abi.tables));assert.throws(()=>{item.abi.tables[0].name='forged'});
 assert.throws(()=>createWireDeploymentRegistryCached([], {get(){return {abi:make(1)}}}),/Unrecognized compiled ABI cache/);
});
