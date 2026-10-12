import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fork} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {hash} from '../src/parser.mjs';import {registerProject,getStatus,getNode,requestAnalysis,waitForJob,currentAnalysisConditions} from '../src/engine.mjs';import {writeLatest,readLatest,projectDir,readJob} from '../src/state.mjs';import {startUI} from '../src/ui.mjs';
const root=path.resolve(import.meta.dirname,'..'),owned=path.join(root,'.local','test-fixtures-shared-jobs',randomUUID());fs.mkdirSync(owned,{recursive:true});
const actor=path.join(owned,'actor.mjs');
fs.writeFileSync(actor,`
import fs from 'node:fs';import {acquireLock,writeJob,releaseLock} from '${pathToFileURL(path.join(root,'src/state.mjs')).href}';import {requestAnalysis,waitForJob} from '${pathToFileURL(path.join(root,'src/engine.mjs')).href}';
const [id,mode,releaseFile]=process.argv.slice(2);
const send=value=>process.send(value);
if(mode==='primitive'){
 const lock=acquireLock(id),job={jobId:lock.token,jobToken:lock.token,ownerPID:process.pid,ownerStartId:lock.ownerStartId,status:'queued',queuedAt:new Date().toISOString(),processed:0};
 writeJob(id,{...job,source:'must-not-persist',apiKey:'must-not-persist',rawResponse:'must-not-persist'});send({phase:'queued',job});
 process.on('message',message=>{if(message==='running'){job.status='running';job.startedAt=new Date().toISOString();job.processed=1;writeJob(id,job);send({phase:'running',job});}
 if(message==='completed'){job.status='completed';job.endedAt=new Date().toISOString();writeJob(id,job);releaseLock(id);send({phase:'completed',job});process.exit(0);}});
}else{
 if(mode==='race'){send({phase:'ready'});await new Promise(resolve=>process.once('message',resolve));}
 let job;try{job=requestAnalysis(id,{maxCalls:0});}catch(error){send({phase:'rejected',message:error.message});process.exit(0);}
 send({phase:'queued',job});const deadline=Date.now()+15000;while(!fs.existsSync(releaseFile)){if(Date.now()>deadline)throw new Error('Owned test barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 const terminal=await waitForJob(id);send({phase:'terminal',job:terminal});process.exit(0);
}`);
function fixture(){
 const source=path.join(owned,randomUUID());fs.mkdirSync(source);const file=path.join(source,'a.py');fs.writeFileSync(file,'def identity(value):\n    return value\n');
 const p=registerProject('Owned shared-job fixture',source),conditions=currentAnalysisConditions(),node={id:'owned-node',file,name:'identity',calls:[],lineMap:[1,2]};
 const good={fixtureKind:'synthetic_old_good_not_quality',settingsHash:conditions,scope:'partial_with_forward_dependencies_and_reverse_impact',graph:{files:[{file,hash:hash(fs.readFileSync(file,'utf8'))}],nodes:[node],diagnostics:[]},meanings:{[node.id]:{id:node.id,input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[]}},nodeSettings:{[node.id]:conditions}};
 writeLatest(p.id,good);return {project:p,good,node,release:path.join(source,'release')};
}
function launch(f,mode){const child=fork(actor,[f.project.id,mode,f.release],{silent:true});child.stderr.resume();return child;}
function message(child){
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clear();reject(new Error('Child timeout'));},20000);const done=value=>{clear();resolve(value);};const exited=code=>{clear();reject(new Error('Child exited before message: '+code));};function clear(){clearTimeout(timer);child.off('message',done);child.off('exit',exited);}child.once('message',done);child.once('exit',exited);});
}
async function stop(child){if(child.exitCode===null&&!child.killed){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;}}
test('independent producer queued/running/terminal is visible through actual HTTP and node reads',async()=>{
 const f=fixture(),child=launch(f,'primitive'),server=await startUI({port:0}),base='http://127.0.0.1:'+server.address().port;
 try{
  const queued=await message(child);assert.equal(queued.phase,'queued');
  const q=await(await fetch(base+'/api/status?id='+f.project.id)).json();assert.equal(q.job.status,'queued');assert.equal(q.job.ownerVerified,true);assert.equal(q.job.jobId,queued.job.jobId);
  const runningMessage=message(child);child.send('running');await runningMessage;
  const running=await(await fetch(base+'/api/status?id='+f.project.id)).json();assert.equal(running.job.status,'running');assert.equal(running.job.processed,1);assert.equal(getNode(f.project.id,f.node.id).job.jobId,queued.job.jobId);
  const persisted=JSON.parse(fs.readFileSync(path.join(projectDir(f.project.id),'job.json'),'utf8'));assert.equal(persisted.source,undefined);assert.equal(persisted.apiKey,undefined);assert.equal(persisted.rawResponse,undefined);
  const done=message(child);child.send('completed');await done;assert.equal(getStatus(f.project.id).job.status,'completed');
  assert.ok(fs.existsSync(path.join(projectDir(f.project.id),'jobs',queued.job.jobId+'.json')));assert.deepEqual(readLatest(f.project.id),f.good);
 }finally{await stop(child);await new Promise(resolve=>server.close(resolve));}
});
test('old local terminal does not hide a new external job; duplicate host joins without overwriting',async()=>{
 const f=fixture();requestAnalysis(f.project.id,{maxCalls:0});assert.equal((await waitForJob(f.project.id)).status,'failed');
 const child=launch(f,'engine');try{
  const queued=await message(child);assert.equal(getStatus(f.project.id).job.jobId,queued.job.jobId);assert.equal(getStatus(f.project.id).job.status,'queued');
  const duplicate=requestAnalysis(f.project.id,{maxCalls:0});assert.equal(duplicate.jobId,queued.job.jobId);
  const done=message(child);fs.writeFileSync(f.release,'go');const terminal=await done;assert.equal(terminal.job.status,'failed');assert.deepEqual(readLatest(f.project.id),f.good);
  const budget=JSON.parse(fs.readFileSync(path.join(root,'.local','rounds',queued.job.jobId,'budget.json'),'utf8'));assert.equal(budget.calls,0);
 }finally{await stop(child);}
});
test('simultaneous real requests produce one owner token and one zero-call round',async()=>{
 const f=fixture(),a=launch(f,'race'),b=launch(f,'race');try{
  await Promise.all([message(a),message(b)]);
  const replies=Promise.all([message(a),message(b)]);a.send('go');b.send('go');const initial=await replies;
  const accepted=initial.filter(r=>r.phase==='queued');assert.ok(accepted.length>=1);assert.equal(new Set(accepted.map(r=>r.job.jobId)).size,1);
  for(const r of initial.filter(r=>r.phase==='rejected'))assert.match(r.message,/already running/);
  const current=getStatus(f.project.id).job;assert.equal(current.ownerVerified,true);assert.equal(current.jobId,accepted[0].job.jobId);
  const waiting=[a,b].filter((child,index)=>initial[index].phase==='queued').map(message);fs.writeFileSync(f.release,'go');await Promise.all(waiting);
  assert.equal(fs.readdirSync(path.join(projectDir(f.project.id),'jobs')).length,1);
  const budget=JSON.parse(fs.readFileSync(path.join(root,'.local','rounds',current.jobId,'budget.json'),'utf8'));assert.equal(budget.calls,0);assert.deepEqual(readLatest(f.project.id),f.good);
 }finally{await stop(a);await stop(b);}
});
test('force-killed verified owner is interrupted and its lock is not automatically removed',async()=>{
 const f=fixture(),child=launch(f,'primitive');await message(child);const before=fs.readFileSync(path.join(projectDir(f.project.id),'job.json'),'utf8');await stop(child);
 const status=getStatus(f.project.id);assert.equal(status.job.status,'interrupted');assert.equal(status.job.ownerVerified,false);
 assert.throws(()=>requestAnalysis(f.project.id,{maxCalls:0}),/already running/);assert.ok(fs.existsSync(path.join(projectDir(f.project.id),'run.lock')));assert.equal(fs.readFileSync(path.join(projectDir(f.project.id),'job.json'),'utf8'),before);assert.deepEqual(readLatest(f.project.id),f.good);
});
test('mismatched token/start identity never claims running even for a live PID',async()=>{
 const f=fixture(),child=launch(f,'primitive');try{
  await message(child);const dir=projectDir(f.project.id),file=path.join(dir,'job.json'),lockFile=path.join(dir,'run.lock');
  const job=JSON.parse(fs.readFileSync(file,'utf8')),lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...job,jobToken:'old-token'}));assert.equal(readJob(f.project.id).status,'unknown');
  fs.writeFileSync(file,JSON.stringify({...job,ownerStartId:'1'}));fs.writeFileSync(lockFile,JSON.stringify({...lock,ownerStartId:'1'}));
  const uncertain=readJob(f.project.id);assert.equal(uncertain.status,'unknown');assert.equal(uncertain.reasonCode,'OWNER_UNVERIFIED');
 }finally{await stop(child);}
});

test('lock without a job record remains unknown, never inferred as queued or running',async()=>{
 const f=fixture();const state=await import('../src/state.mjs');const lock=state.acquireLock(f.project.id);
 try{assert.equal(getStatus(f.project.id).job.status,'unknown');assert.equal(getStatus(f.project.id).job.reasonCode,'LOCK_WITHOUT_JOB');assert.throws(()=>requestAnalysis(f.project.id,{maxCalls:0}),/already running/);}
 finally{state.releaseLock(f.project.id);}
 assert.deepEqual(readLatest(f.project.id),f.good);
});
test('lost token before scheduled start blocks analysis and never overwrites the foreign lock/job',async()=>{
 const f=fixture(),child=launch(f,'engine');try{
  const queued=await message(child),dir=projectDir(f.project.id),lockFile=path.join(dir,'run.lock'),jobFile=path.join(dir,'job.json');
  const lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));fs.writeFileSync(lockFile,JSON.stringify({...lock,token:'foreign-token'}));
  const before=fs.readFileSync(jobFile,'utf8'),done=message(child);fs.writeFileSync(f.release,'go');const result=await done;
  assert.equal(result.job.status,'unknown');assert.equal(fs.readFileSync(jobFile,'utf8'),before);assert.equal(JSON.parse(fs.readFileSync(lockFile,'utf8')).token,'foreign-token');
  assert.ok(!fs.existsSync(path.join(root,'.local','rounds',queued.job.jobId,'budget.json')));assert.deepEqual(readLatest(f.project.id),f.good);
 }finally{await stop(child);}
});
