import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {registerProject,requestAnalysis,waitForJob,getStatus,currentAnalysisConditions} from '../src/engine.mjs';import {writeLatest} from '../src/state.mjs';
const root=path.resolve(import.meta.dirname,'..','.local','test-fixtures-diagnostic',randomUUID());fs.mkdirSync(root,{recursive:true});
function fixture(label,extra={}){const source=path.join(root,label);fs.mkdirSync(source);const files={'good.py':'def selected(value):\n    return value\n','bad.css':'.broken { color: red;',...extra};for(const [name,text]of Object.entries(files))fs.writeFileSync(path.join(source,name),text);const project=registerProject('Owned diagnostic scope '+label,source);return {project,source,nodeId:path.join(source,'good.py').replaceAll('\\','/')+'::selected'};}
async function run(f,options){requestAnalysis(f.project.id,{...options,maxCalls:0,maxInputTokens:8000,maxOutputTokens:2000});const job=await waitForJob(f.project.id);return {job,status:getStatus(f.project.id)};}
function diagnostic(status){assert.ok(status.structure);assert.equal(status.structure.structureComplete,false);assert.ok(status.structure.graph.diagnostics.some(d=>d.file.endsWith('bad.css')&&d.status==='parse_failed'));}
test('valid selected node/file survives unrelated CSS diagnostic and reaches zero-call meaning budget',async()=>{
 for(const selection of ['node','file']){const f=fixture('valid-'+selection),{job,status}=await run(f,selection==='node'?{nodeIds:[f.nodeId]}:{files:['good.py']});assert.equal(job.status,'failed');assert.match(job.reason,/additional allocated calls/);diagnostic(status);assert.deepEqual(status.structure.selectedNodeIds,[f.nodeId]);assert.equal(status.structure.qualityStatus,'stage12_partial_with_diagnostics');const budget=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'..','.local','rounds',job.jobId,'budget.json'),'utf8'));assert.equal(budget.calls,0);}
});
test('explicitly requested malformed file fails honestly and exposes incomplete structure',async()=>{
 const f=fixture('bad-request'),{job,status}=await run(f,{files:['bad.css']});assert.equal(job.status,'failed');assert.match(job.reason,/Requested file source graph diagnostics/);diagnostic(status);assert.equal(status.structure.qualityStatus,'stage12_incomplete');assert.equal(status.latest,null);
});
test('whole request with diagnostic fails and preserves the old synthetic normal snapshot',async()=>{
 const f=fixture('whole'),first=await run(f,{nodeIds:[f.nodeId]});const old={fixtureKind:'synthetic_metadata_only_not_LLM_quality',graph:first.status.structure.graph,meanings:{},settingsHash:currentAnalysisConditions()};writeLatest(f.project.id,old);
 const {job,status}=await run(f,{});assert.equal(job.status,'failed');assert.match(job.reason,/Source graph diagnostics/);diagnostic(status);assert.equal(status.structure.qualityStatus,'stage12_incomplete');assert.deepEqual(status.latest,old);
});
test('missing requested node fails rather than claiming an unreadable definition exists',async()=>{
 const f=fixture('missing'),{job,status}=await run(f,{nodeIds:['unavailable-definition']});assert.equal(job.status,'failed');assert.match(job.reason,/not present in current project graph/);diagnostic(status);assert.equal(status.latest,null);
});
test('unparsed imported dependency stays unresolved; valid caller structure is retained',async()=>{
 const f=fixture('unresolved',{'good.py':'from broken import leaf\n\ndef selected(value):\n    return leaf(value)\n','broken.py':'def leaf(:\n'}),{job,status}=await run(f,{nodeIds:[f.nodeId]});assert.match(job.reason,/additional allocated calls/);diagnostic(status);const node=status.structure.graph.nodes.find(n=>n.id===f.nodeId),call=node.calls.find(c=>c.name==='leaf');assert.equal(call.targetId,null);assert.ok(call.relationReason);assert.ok(status.structure.graph.diagnostics.some(d=>d.file.endsWith('broken.py')));
});
