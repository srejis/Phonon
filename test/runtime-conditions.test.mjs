import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {captureRuntimeConditions,checkRuntimeConditions,assertRuntimeConditions,STATIC_ANALYSIS_FILES} from '../src/runtime-conditions.mjs';
const root=path.resolve(import.meta.dirname,'..');
function fixture(){
 const dir=path.join(root,'.local','test-fixtures-runtime',randomUUID());
 fs.mkdirSync(path.join(dir,'src'),{recursive:true});
 fs.mkdirSync(path.join(dir,'experiments'),{recursive:true});
 fs.writeFileSync(path.join(dir,'src/host.mjs'),'export const budget=6000;');
 fs.writeFileSync(path.join(dir,'experiments/h3.mjs'),'export const version=1;');
 fs.writeFileSync(path.join(dir,'package.json'),'{"version":"1"}');
 fs.writeFileSync(path.join(dir,'package-lock.json'),'{"lockfileVersion":3}');
 return dir;
}
test('unchanged statically loaded files permit analysis and preserve startup identity',()=>{
 const dir=fixture(),captured=captureRuntimeConditions({root:dir,files:['src/host.mjs']});
 assert.equal(assertRuntimeConditions(captured).restartRequired,false);
 assert.equal(checkRuntimeConditions(captured).runtimeFingerprint,captured.fingerprint);
});
test('H3 dynamic changes do not require restart of static host modules',()=>{
 assert.equal(STATIC_ANALYSIS_FILES.includes('experiments/h3.mjs'),false);
 const dir=fixture(),captured=captureRuntimeConditions({root:dir,files:['src/host.mjs']});
 fs.writeFileSync(path.join(dir,'experiments/h3.mjs'),'export const version=2;');
 assert.equal(assertRuntimeConditions(captured).restartRequired,false);
});
test('disk replacement cannot relabel cached old module execution',async()=>{
 const dir=fixture(),file=path.join(dir,'src/host.mjs');
 const runtime=await import(pathToFileURL(file).href);
 const captured=captureRuntimeConditions({root:dir,files:['src/host.mjs']});
 fs.writeFileSync(file,'export const budget=16000;');
 assert.equal(runtime.budget,6000);
 assert.equal((await import(pathToFileURL(file).href)).budget,6000);
 assert.deepEqual(checkRuntimeConditions(captured).changedFiles,[{file:'src/host.mjs',reason:'content_changed'}]);
 assert.throws(()=>assertRuntimeConditions(captured),{code:'RUNTIME_RESTART_REQUIRED'});
 assert.notEqual(captureRuntimeConditions({root:dir,files:['src/host.mjs']}).fingerprint,captured.fingerprint);
});
test('missing runtime source produces restart requirement without exposing contents',()=>{
 const dir=fixture(),captured=captureRuntimeConditions({root:dir,files:['src/host.mjs']});
 fs.renameSync(path.join(dir,'src/host.mjs'),path.join(dir,'src/renamed.mjs'));
 assert.deepEqual(checkRuntimeConditions(captured).changedFiles,[{file:'src/host.mjs',reason:'unavailable',code:'ENOENT'}]);
 assert.throws(()=>assertRuntimeConditions(captured),{code:'RUNTIME_RESTART_REQUIRED'});
});
for(const file of ['package.json','package-lock.json']){
 test(file+' version manifest change requires restart',()=>{
  assert.ok(STATIC_ANALYSIS_FILES.includes(file));
  const dir=fixture(),captured=captureRuntimeConditions({root:dir,files:['src/host.mjs',file]});
  fs.writeFileSync(path.join(dir,file),'{"version":"changed"}');
  assert.equal(checkRuntimeConditions(captured).restartRequired,true);
  assert.equal(checkRuntimeConditions(captured).changedFiles[0].file,file);
 });
}
test('failure policy and runtime guard are covered, capture immutable and root constrained',()=>{
 assert.ok(STATIC_ANALYSIS_FILES.includes('src/failure-policy.mjs'));
 assert.ok(STATIC_ANALYSIS_FILES.includes('src/runtime-conditions.mjs'));
 const dir=fixture(),captured=captureRuntimeConditions({root:dir,files:['src/host.mjs']});
 assert.equal(Object.isFrozen(captured),true);
 assert.equal(Object.isFrozen(captured.files[0]),true);
 assert.throws(()=>captureRuntimeConditions({root:dir,files:['../outside.mjs']}),/outside host root/);
 assert.throws(()=>captureRuntimeConditions({root:dir,files:['.env']}),/local .mjs or .json/);
});

async function isolatedEngine(){
 // Copy only Phonon host implementation into an owned mutable fixture.
 // External project sources are never copied or executed.
 const dir=fixture();
 for(const file of STATIC_ANALYSIS_FILES){
  const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(root,file),target);
 }
 const engine=await import(pathToFileURL(path.join(dir,'src/engine.mjs')).href);
 const state=await import(pathToFileURL(path.join(dir,'src/state.mjs')).href);
 const source=path.join(dir,'owned-source');fs.mkdirSync(source);
 const file=path.join(source,'owned.py');fs.writeFileSync(file,'def owned(value):\n    return value\n');
 const project=engine.registerProject('Owned runtime guard fixture',source);
 const id='runtime-fixture::owned',conditions=engine.currentAnalysisConditions();
 const snapshot={fixtureKind:'synthetic_metadata_not_quality',settingsHash:conditions,
  graph:{files:[{file,hash:(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex')}],
   nodes:[{id,name:'owned',file,source:'def owned(value):\n    return value',calls:[],lineMap:[1,2]}]},
  meanings:{[id]:{id,input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[]}},
  nodeSettings:{[id]:conditions}};
 state.writeLatest(project.id,snapshot);
 return {dir,engine,state,project,id,snapshot};
}
test('real isolated engine rejects changed runtime while status/node remain readable',async()=>{
 const f=await isolatedEngine(),before=f.engine.getStatus(f.project.id);
 fs.appendFileSync(path.join(f.dir,'src/analysis-budget.mjs'),'\n// owned fixture change\n');
 assert.throws(()=>f.engine.requestAnalysis(f.project.id,{maxCalls:0}),{code:'RUNTIME_RESTART_REQUIRED'});
 const status=f.engine.getStatus(f.project.id);
 assert.equal(status.restartRequired,true);
 assert.ok(status.runtime.changedFiles.some(file=>file.file==='src/analysis-budget.mjs'));
 assert.equal(status.runtime.runtimeFingerprint,before.runtime.runtimeFingerprint);
 assert.notEqual(status.desiredConditions,before.desiredConditions);
 assert.equal(status.job,null);
 assert.equal(f.engine.getNode(f.project.id,f.id).meaning.id,f.id);
 assert.deepEqual(f.state.readLatest(f.project.id),f.snapshot);
});
test('queued analysis checks runtime again at start and preserves previous snapshot',async()=>{
 const f=await isolatedEngine();
 f.engine.requestAnalysis(f.project.id,{maxCalls:0});
 fs.appendFileSync(path.join(f.dir,'src/failure-policy.mjs'),'\n// owned fixture change before queued job starts\n');
 const job=await f.engine.waitForJob(f.project.id);
 assert.equal(job.status,'failed');
 assert.equal(job.processed,0);
 assert.match(job.reason,/다시 시작/);
 assert.deepEqual(f.state.readLatest(f.project.id),f.snapshot);
});
