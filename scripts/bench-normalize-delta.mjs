import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createProtocolProvider} from '../dist/provider.js';
import {createWireValueCodec,codecProfiles} from '../dist/index.js';
const profile=codecProfiles[1],provider=createProtocolProvider(profile.id),transport=createWireValueCodec(JSON.parse(readFileSync('fixtures/codec/ship.abi.json')),profile),hex=b=>Buffer.from(b).toString('hex');
const abi=provider.contractCodec.decodeAbi(provider.contractCodec.encodeAbi({version:'sysio::abi/1.3',tables:[{name:'records',index_type:'',key_names:[],key_types:[],type:'uint64',table_id:0,secondary_indexes:[{name:'owner',key_type:'uint64',table_id:65535}]}]}));
const dep={id:'measured-abi',from:{blockNum:10,ordinal:0},abiHex:hex(provider.contractCodec.encodeAbi(abi)),abi};
const context={chainId:'a'.repeat(64),blockId:'b'.repeat(64),blockNum:10,ordinal:1,abiDeployment:dep};
const inputs=[];for(let i=0;i<64;i++){const secondary=i%4===0;const kind=secondary?'contract_index_kv':'contract_row_kv';const body=secondary?{code:'contract',payer:'payer',table_id:65535,sec_key:i.toString(16).padStart(4,'0'),pri_key:'00'}:{code:'contract',payer:'payer',table_id:0,key:i.toString(16).padStart(4,'0'),value:'ffffffffffffffff'};const value=[kind+'_v0',body];const raw=transport.encode(kind,value);inputs.push({stream:kind,present:i%7!==0,raw,value:transport.decode(kind,raw)})}
const count=Number(process.env.ITERATIONS??10000);for(let i=0;i<1000;i++)provider.normalizeDelta(inputs[i%inputs.length],context);
const digest=createHash('sha256');const start=performance.now();for(let i=0;i<count;i++)digest.update(JSON.stringify(provider.normalizeDelta(inputs[i%inputs.length],context))+'\n');const ms=performance.now()-start;console.log(JSON.stringify({profile:profile.id,iterations:count,elapsedMs:ms,perSecond:count*1000/ms,digest:digest.digest('hex'),corpus:'constructed 64 kv rows/indexes with pinned Wire69 provider and captured handshake'}));
