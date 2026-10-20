/** Offline official-clio fixture oracle; never imports the implementation under test. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const host=option('--host');
const clio=option('--clio','/srv/hyperion-wire-testnet/20261019-node-setup/runtime/wire-sysio/bin/clio');
const remoteRoot=option('--remote-root','/srv/hyperion-wire-testnet/20261019-node-setup/codec-oracle-issue2');
if(!host||!/^[A-Za-z0-9_.@:-]+$/.test(host))throw new Error('--host with a safe SSH hostname is required');
for(const p of[clio,remoteRoot])if(!p.startsWith('/srv/hyperion-wire-testnet/')||p.includes('..'))throw new Error('Use explicit owned /srv/hyperion-wire-testnet paths');
const manifest=JSON.parse(readFileSync(resolve(root,'fixtures/codec/artifacts/manifest.json'),'utf8'));
const cases=JSON.parse(readFileSync(resolve(root,'fixtures/codec/oracle-cases.json'),'utf8')).cases;
const artifacts=manifest.artifacts.filter(x=>x.kind==='abi').map(x=>{const b=readFileSync(resolve(root,'fixtures/codec',x.retainedPath));if(createHash('sha256').update(b).digest('hex')!==x.sha256)throw new Error('ABI digest mismatch');return {...x,data:b.toString('base64')};});
const remotePython=String.raw`
import sys,json,pathlib,subprocess,hashlib,base64,datetime
p=json.load(sys.stdin); root=pathlib.Path(p['remoteRoot']);root.mkdir(parents=True,exist_ok=True)
clio=p['clio']; digest=hashlib.sha256(pathlib.Path(clio).read_bytes()).hexdigest()
assert digest=='a8298cc96d0265b384aebba178d255ff73917fcae0a0d4abf086f45016efb76a','The selected clio does not match the pinned producer revision'
producer={'sourceRevision':'7dede884e0150d36fa788e85a119e10653ade8ca','version':subprocess.run([clio,'version','client'],capture_output=True,text=True,check=True).stdout.strip(),'binarySha256':digest,'nodeExecution':False,'contractDeployment':False}
files={}; vectors=[]; failures=[];commands=[]
def run(args):
 r=subprocess.run([clio,'convert']+args,capture_output=True,text=True,timeout=20)
 record={'args':['convert']+args,'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr};commands.append(record)
 try:
  if r.returncode or not r.stdout.strip() or 'ERROR: Unable to convert' in r.stderr:raise ValueError('serializer failed (clio can exit 0)')
  return json.loads(r.stdout)
 except Exception as e:raise ValueError(str(e))
for a in p['artifacts']:
 path=root/a['retainedPath'];path.parent.mkdir(parents=True,exist_ok=True);b=base64.b64decode(a['data']);assert hashlib.sha256(b).hexdigest()==a['sha256'];path.write_bytes(b);files[(a['profileId'],a['contract'])]=str(path)
 try:
  packed=run(['pack_hex',str(path),'--type','abi_def']);assert isinstance(packed,str) and len(packed)%2==0
  expected=run(['unpack_hex',packed]);assert isinstance(expected,dict) and expected.get('version','').startswith('sysio::abi/')
  vectors.append({'id':a['profileId']+'-abi-'+a['contract'],'operation':'decodeAbi','profileId':'wire-sysio-'+a['profileId']+'-engineering-v1','hex':packed.lower(),'expected':expected,'abiPath':a['retainedPath'],'oracle':'official-clio-offline'})
 except Exception as e:failures.append({'id':a['profileId']+'-abi-'+a['contract'],'error':str(e)})
for c in p['cases']:
 profiles=c.get('profiles',['6508c9e8','7dede884'] if 'contract' in c else ['7dede884'])
 for profile in profiles:
  args=['--type',c['typeName']]
  if 'contract' in c:args+=['--abi-file',files[(profile,c['contract'])]]
  caseFile=root/('case-'+profile+'-'+c['id']+'.json');caseFile.write_text(json.dumps(c['input'],ensure_ascii=False),encoding='utf8')
  try:
   packed=run(['pack_hex',str(caseFile)]+args);assert isinstance(packed,str)
   expected=run(['unpack_hex',packed]+args)
   v={'id':profile+'-'+c['id'],'operation':'decodeValue','profileId':'wire-sysio-'+profile+'-engineering-v1','typeName':c['typeName'],'hex':packed.lower(),'input':c['input'],'expected':expected,'oracle':'official-clio-offline'}
   if 'contract' in c:v['abiPath']='artifacts/'+profile+'/'+c['contract']+'.abi'
   vectors.append(v)
  except Exception as e:failures.append({'id':profile+'-'+c['id'],'error':str(e)})
# Explicit release slug ABI shape, enum metadata and raw crypto render probes.
for profile,typ,hx,abi in [('7dede884','slug_name','0000000080140000','sysio.chains'),('7dede884','public_key','000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',None),('7dede884','signature','00'+'1f'+'00'*64,None)]:
 args=['--type',typ]+(['--abi-file',files[(profile,abi)]] if abi else [])
 try:
  expected=run(['unpack_hex',hx]+args)
  v={'id':profile+'-raw-'+typ,'operation':'decodeValue','profileId':'wire-sysio-'+profile+'-engineering-v1','typeName':typ,'hex':hx,'expected':expected,'oracle':'official-clio-offline'}
  if abi:v['abiPath']='artifacts/'+profile+'/'+abi+'.abi'
  vectors.append(v)
 except Exception as e:failures.append({'id':profile+'-raw-'+typ,'error':str(e)})
print(json.dumps({'schemaVersion':1,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'producer':producer,'vectors':vectors,'failures':failures,'commands':commands},ensure_ascii=False))
`;
const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const command='python3 -c '+shellQuote(remotePython);
const result=spawnSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,command],{input:JSON.stringify({clio,remoteRoot,artifacts,cases}),encoding:'utf8',maxBuffer:32*1024*1024,timeout:10*60*1000});
if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr||'SSH capture failed');
const capture=JSON.parse(result.stdout);
const output=resolve(root,option('--output','fixtures/codec/oracle-capture.json'));mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(capture,null,2)+'\n');
const vectorsOutput=resolve(root,'fixtures/codec/oracle-vectors.json');writeFileSync(vectorsOutput,JSON.stringify({schemaVersion:1,producer:capture.producer,vectors:capture.vectors},null,2)+'\n');
console.log(JSON.stringify({capture:output,vectors:capture.vectors.length,failures:capture.failures,producer:capture.producer},null,2));
