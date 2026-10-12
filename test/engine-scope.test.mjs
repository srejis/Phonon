import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerProject,requestAnalysis,waitForJob,getStatus,currentAnalysisConditions} from '../src/engine.mjs';
import {writeLatest} from '../src/state.mjs';
const root=path.resolve(import.meta.dirname,'..','.local','test-fixtures-scope',randomUUID());
fs.mkdirSync(root,{recursive:true});
async function structure(name,files,selected){
 const source=path.join(root,name);fs.mkdirSync(source,{recursive:true});
 for(const [file,text]of Object.entries(files))fs.writeFileSync(path.join(source,file),text);
 const project=registerProject('Owned structural scope regression '+name,source);
 const scope=typeof selected==='function'?selected(source):{files:selected};
 requestAnalysis(project.id,{...scope,maxCalls:0,maxInputTokens:6000,maxOutputTokens:2000});
 const job=await waitForJob(project.id),status=getStatus(project.id);
 // No synthetic meanings: zero paid budget legitimately stops at missing meaning generation.
 assert.equal(job.status,'failed');assert.match(job.reason,/additional allocated calls/);
 assert.ok(status.structure);assert.equal(status.latest,null);
 const budget=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'..','.local','rounds',job.jobId,'budget.json'),'utf8'));
 assert.equal(budget.calls,0);assert.equal(budget.limits.maxCalls,0);
 assert.equal(Object.hasOwn(status.limits,'files'),false);assert.equal(Object.hasOwn(status.limits,'nodes'),false);
 return {...status.structure,fixtureProjectId:project.id};
}
test('65-file project keeps full structure while a one-file request selects one meaning scope',async()=>{
 const files=Object.fromEntries(Array.from({length:65},(_,i)=>[`f${i}.py`,`def f${i}(value):\n    return value\n`]));
 const result=await structure('65-files',files,['f0.py']);
 assert.equal(result.graph.files.length,65);assert.equal(result.graph.nodes.length,65);
 assert.equal(result.selectedNodeIds.length,1);assert.match(result.selectedNodeIds[0],/::f0$/);
});
test('one file with 101 nodes reaches meaning budget stage without an arbitrary node cap',async()=>{
 const source=Array.from({length:101},(_,i)=>`def f${i}(value):\n    return value\n`).join('\n');
 const result=await structure('101-nodes',{'many.py':source},['many.py']);
 assert.equal(result.graph.nodes.length,101);assert.equal(result.selectedNodeIds.length,101);
});
test('explicit selection of more than 64 files is accepted without changing paid call limits',async()=>{
 const files=Object.fromEntries(Array.from({length:65},(_,i)=>[`f${i}.py`,`def f${i}(value):\n    return value\n`]));
 const result=await structure('65-selected',files,Object.keys(files));
 assert.equal(result.graph.files.length,65);assert.equal(result.selectedNodeIds.length,65);
});

const id=(root,file,name)=>path.join(root,file).replaceAll('\\','/')+'::'+name;
test('node selection keeps 103-node full structure but one independent paid meaning scope',async()=>{
 const source=Array.from({length:103},(_,i)=>`def f${i}(value):\n    return value\n`).join('\n');
 const result=await structure('103-one-node',{'many.py':source},root=>({nodeIds:[id(root,'many.py','f7')]}));
 assert.equal(result.graph.nodes.length,103);assert.equal(result.selectedNodeIds.length,1);assert.match(result.selectedNodeIds[0],/::f7$/);
});
test('first node selection includes forward dependencies without paying for unrequested new callers',async()=>{
 const source='def leaf(value):\n    return value\n\ndef caller(value):\n    return leaf(value)\n\ndef unused(value):\n    return value\n';
 for(const name of ['leaf','caller']){
  const result=await structure('closure-'+name,{'calls.py':source},root=>({nodeIds:[id(root,'calls.py',name)]}));
  assert.deepEqual(result.selectedNodeIds.map(n=>n.split('::').at(-1)).sort(),name==='leaf'?['leaf']:['caller','leaf']);
 }
});
test('file plus node selectors form a union rather than an intersection',async()=>{
 const result=await structure('union',{'a.py':'def alpha(v):\n    return v\n','b.py':'def beta(v):\n    return v\n'},root=>({files:['a.py'],nodeIds:[id(root,'b.py','beta')]}));
 assert.deepEqual(result.selectedNodeIds.map(n=>n.split('::').at(-1)).sort(),['alpha','beta']);
});
test('unknown current node id fails honestly before any model request',async()=>{
 const source=path.join(root,'unknown-id');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'a.py'),'def alpha(v):\n    return v\n');
 const project=registerProject('Owned unknown node scope',source);
 requestAnalysis(project.id,{nodeIds:['does-not-exist'],maxCalls:0});const job=await waitForJob(project.id);
 assert.equal(job.status,'failed');assert.match(job.reason,/not present in current project graph/);assert.equal(job.processed,0);
 assert.equal(getStatus(project.id).latest,null);
 assert.throws(()=>requestAnalysis(project.id,{nodeIds:[null],maxCalls:0}),/nonempty node identifiers/);
});

test('updating a selected callee includes callers with previously stored meanings only',async()=>{
 const source='def leaf(value):\n    return value\n\ndef caller(value):\n    return leaf(value)\n\ndef unknown_caller(value):\n    return leaf(value)\n';
 const initial=await structure('existing-reverse',{'calls.py':source},root=>({nodeIds:[id(root,'calls.py','leaf')]}));
 const known=initial.graph.nodes.filter(n=>['leaf','caller'].includes(n.name));
 const meanings=Object.fromEntries(known.map(n=>[n.id,{id:n.id,input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[],ownerChecks:[]}]));
 // Synthetic saved metadata establishes prior caller provenance, not LLM quality or cache success.
 writeLatest(initial.fixtureProjectId,{fixtureKind:'synthetic_prior_meaning_scope_only',graph:initial.graph,meanings,settingsHash:currentAnalysisConditions(),childVersions:{}});
 const leaf=known.find(n=>n.name==='leaf');requestAnalysis(initial.fixtureProjectId,{nodeIds:[leaf.id],maxCalls:0});
 const job=await waitForJob(initial.fixtureProjectId);assert.equal(job.status,'failed');assert.match(job.reason,/additional allocated calls/);
 const current=getStatus(initial.fixtureProjectId);
 assert.deepEqual(current.structure.selectedNodeIds.map(n=>n.split('::').at(-1)).sort(),['caller','leaf']);
 assert.ok(!current.structure.selectedNodeIds.some(n=>n.endsWith('::unknown_caller')));
 assert.deepEqual(current.latest.meanings,meanings);
});
