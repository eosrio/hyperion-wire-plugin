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
 const shortRow=[row[0],{...row[1],value:'ff'}];const shortRaw=physical.encode('contract_row_kv',shortRow);
 const invalidValue={...input,raw:shortRaw,value:physical.decode('contract_row_kv',shortRaw)};
 for(let i=0;i<2;i++) { assert.throws(()=>provider.normalizeDelta(invalidValue,ctx)); assert.throws(()=>provider.normalizeDelta(input,{...ctx,ordinal:5}),/Missing ABI deployment/); assert.deepEqual(provider.normalizeDelta(input,ctx),first); }
 const largeAbi={...make(),abi_extensions:[[0,'ab'.repeat(66000)]]};const largeBytes=provider.contractCodec.encodeAbi(largeAbi);assert(largeBytes.length>64*1024);
 const largeCache=createWireCompiledAbiCache(),largeHex=hex(largeBytes);assert.notStrictEqual(largeCache.get(largeHex,profile.id).abi,largeCache.get(largeHex,profile.id).abi);
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

test('compiled ABI cache retains exact hits, updates LRU, evicts at eight and separates profiles',()=>{
 const profile=codecProfiles[0],other=codecProfiles[1];
 const provider=createProtocolProvider(profile.id),cache=createWireCompiledAbiCache();
 const abiHex=i=>hex(provider.contractCodec.encodeAbi({version:'sysio::abi/1.3',tables:[{name:'records'+i,index_type:'',key_names:[],key_types:[],type:'uint64',table_id:0,secondary_indexes:[]}]}));
 const first=abiHex(0),original=cache.get(first,profile.id).abi;
 assert.strictEqual(cache.get(first,profile.id).abi,original,'exact hit must reuse ABI object');
 const prior=[];for(let i=1;i<=7;i++)prior.push(cache.get(abiHex(i),profile.id).abi);
 assert.strictEqual(cache.get(first,profile.id).abi,original,'hit refreshes LRU');
 cache.get(abiHex(8),profile.id);
 assert.strictEqual(cache.get(first,profile.id).abi,original,'recently touched entry remains');
 assert.notStrictEqual(cache.get(abiHex(1),profile.id).abi,prior[0],'least recently used entry was evicted');
 const separate=createWireCompiledAbiCache();const firstObject=separate.get(first,profile.id).abi;
 for(let i=1;i<=8;i++)separate.get(abiHex(i),profile.id);
 assert.notStrictEqual(separate.get(first,profile.id).abi,firstObject,'eight additional ABIs evict the first');
 const byProfile=createWireCompiledAbiCache();const a=byProfile.get(first,profile.id).abi,b=byProfile.get(first,other.id).abi;
 assert.notStrictEqual(a,b,'profiles cannot share artifacts');
 assert.strictEqual(byProfile.get(first,profile.id).abi,a);assert.strictEqual(byProfile.get(first,other.id).abi,b);
});
