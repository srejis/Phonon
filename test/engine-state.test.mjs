import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../src/parser.mjs';
import {registerProject, getStatus, getNode, currentAnalysisConditions} from '../src/engine.mjs';
import {writeLatest, readLatest} from '../src/state.mjs';

// Synthetic metadata fixtures only: not generated LLM explanations or quality evidence.
// These checks exercise native getStatus/getNode reads, not native analysis/cache promotion.
const root=path.resolve(import.meta.dirname,'..');
const fixtureRoot=path.join(root,'.local','test-fixture-engineState',`${process.pid}-${randomUUID()}`);
fs.mkdirSync(fixtureRoot,{recursive:true});
function fingerprint(){return currentAnalysisConditions();}
function fixture(label){
 const source=path.join(fixtureRoot,label);fs.mkdirSync(source,{recursive:true});
 const file=path.join(source,'owned.py');fs.writeFileSync(file,'def first(value):\n    return value\n\ndef second(value):\n    return value\n');
 const project=registerProject(`Synthetic engine-state ${label}`,source);
 const nodes=[{id:`${label}:first`,file,name:'first',calls:[],lineMap:[1,2]},
  {id:`${label}:second`,file,name:'second',calls:[],lineMap:[4,5]}];
 const current=fingerprint();
 const snapshot={fixtureKind:'synthetic_metadata_not_llm_quality',settingsHash:current,
  graph:{files:[{file,hash:hash(fs.readFileSync(file,'utf8'))}],nodes,diagnostics:[]},
  meanings:Object.fromEntries(nodes.map(node=>[node.id,{id:node.id,input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[]} ])),
  nodeSettings:Object.fromEntries(nodes.map(node=>[node.id,current])),childVersions:{}};
 return {project,file,nodes,current,snapshot};
}
function seed(f){writeLatest(f.project.id,f.snapshot);}

test('matching synthetic baseline remains fresh and status reads preserve its snapshot',()=>{
 const f=fixture('baseline');seed(f);const before=readLatest(f.project.id);
 const status=getStatus(f.project.id);
 assert.equal(status.stale,false);assert.deepEqual(status.changedFiles,[]);assert.deepEqual(status.staleNodeIds,[]);
 assert.equal(status.inventoryError,null);assert.deepEqual(readLatest(f.project.id),before);
});

test('a newly added supported file makes project stale even when all old nodes are fresh',()=>{
 const f=fixture('added');seed(f);const added=path.join(f.project.sourcePath,'new.py');
 fs.writeFileSync(added,'def new(value):\n    return value\n');
 const before=readLatest(f.project.id),status=getStatus(f.project.id);
 assert.equal(status.stale,true);assert.deepEqual(status.changedFiles,[added]);assert.deepEqual(status.staleNodeIds,[]);
 assert.equal(getNode(f.project.id,f.nodes[0].id).stale,false);
 assert.equal(getNode(f.project.id,f.nodes[0].id).projectStale,true);
 assert.deepEqual(readLatest(f.project.id),before);
});

test('same-file mixed current/old nodeSettings marks exactly the old-condition node stale',()=>{
 const f=fixture('mixed');f.snapshot.nodeSettings[f.nodes[1].id]='synthetic-old-condition';seed(f);
 const status=getStatus(f.project.id);
 assert.equal(status.stale,true);assert.deepEqual(status.changedFiles,[]);
 assert.deepEqual(status.staleNodeIds,[f.nodes[1].id]);
 assert.equal(getNode(f.project.id,f.nodes[0].id).stale,false);
 assert.equal(getNode(f.project.id,f.nodes[1].id).stale,true);
});

test('missing node meaning is incomplete coverage, while getNode retains not-generated behavior',()=>{
 const f=fixture('missing');delete f.snapshot.meanings[f.nodes[0].id];seed(f);
 const status=getStatus(f.project.id);
 assert.equal(status.stale,false);assert.deepEqual(status.staleNodeIds,[]);
 assert.deepEqual(status.unexplainedNodeIds,[f.nodes[0].id]);assert.equal(status.coverage.complete,false);assert.equal(status.coverage.unexplainedNodes,1);assert.equal(status.coverage.staleExplainedNodes,0);
 const result=getNode(f.project.id,f.nodes[0].id);assert.equal(result.meaning,null);assert.equal(result.stale,true);assert.equal(result.explanationStatus,'not_generated');
});

test('deleted previously normal source is detected without altering old successful metadata',()=>{
 const f=fixture('deleted');seed(f);const before=readLatest(f.project.id);
 fs.unlinkSync(f.file); // Only this test-owned single file is removed.
 const status=getStatus(f.project.id);
 assert.equal(status.stale,true);assert.deepEqual(status.changedFiles,[f.file]);
 assert.deepEqual(status.staleNodeIds,f.nodes.map(n=>n.id));
 assert.deepEqual(readLatest(f.project.id),before);
});

test('per-node condition records override old whole-snapshot condition after a synthetic partial promotion',()=>{
 const f=fixture('per-node-overrides');f.snapshot.settingsHash='synthetic-old-global-condition';seed(f);
 const status=getStatus(f.project.id);
 assert.equal(status.stale,false);assert.deepEqual(status.staleNodeIds,[]);
 // A current global marker cannot mask untouched old node metadata either.
 f.snapshot.settingsHash=f.current;f.snapshot.nodeSettings[f.nodes[0].id]='synthetic-untouched-old';seed(f);
 assert.deepEqual(getStatus(f.project.id).staleNodeIds,[f.nodes[0].id]);
});

test('legacy snapshots fall back to global conditions and changed same-file source marks all its nodes',()=>{
 const f=fixture('legacy');delete f.snapshot.nodeSettings;seed(f);
 assert.equal(getStatus(f.project.id).stale,false);
 f.snapshot.settingsHash='synthetic-old-condition';seed(f);
 assert.deepEqual(getStatus(f.project.id).staleNodeIds,f.nodes.map(n=>n.id));
 f.snapshot.settingsHash=f.current;seed(f);fs.appendFileSync(f.file,'\n# owned fixture changed\n');
 const status=getStatus(f.project.id);
 assert.deepEqual(status.changedFiles,[f.file]);assert.deepEqual(status.staleNodeIds,f.nodes.map(n=>n.id));
});

test('partial coverage retains current explanations without labeling unexplained siblings stale',()=>{
 const f=fixture('partial-coverage');delete f.snapshot.meanings[f.nodes[1].id];f.snapshot.scope='partial_with_forward_dependencies_and_reverse_impact';seed(f);
 const status=getStatus(f.project.id);
 assert.equal(status.stale,false);assert.deepEqual(status.staleNodeIds,[]);
 assert.deepEqual(status.unexplainedNodeIds,[f.nodes[1].id]);
 assert.equal(status.coverage.explainedNodes,1);assert.equal(status.coverage.currentExplainedNodes,1);
 assert.equal(status.coverage.scopeKind,'partial');assert.equal(status.coverage.complete,false);
 assert.equal(getNode(f.project.id,f.nodes[0].id).explanationStatus,'current');
});
test('an unexplained dependency invalidates only existing upstream explanations',()=>{
 const f=fixture('missing-dependency');delete f.snapshot.meanings[f.nodes[0].id];
 f.snapshot.graph.nodes[1].calls=[{targetId:f.nodes[0].id}];seed(f);
 const status=getStatus(f.project.id);
 assert.deepEqual(status.unexplainedNodeIds,[f.nodes[0].id]);
 assert.deepEqual(status.staleNodeIds,[f.nodes[1].id]);
 assert.equal(status.coverage.staleExplainedNodes,1);
});
test('changes propagate through unexplained intermediate nodes to an existing parent',()=>{
 const f=fixture('intermediate');const leaf={id:'intermediate:leaf',file:f.file,name:'leaf',calls:[],lineMap:[1]};
 f.snapshot.graph.nodes.push(leaf);delete f.snapshot.meanings[f.nodes[0].id];
 f.snapshot.graph.nodes[0].calls=[{targetId:leaf.id}];f.snapshot.graph.nodes[1].calls=[{targetId:f.nodes[0].id}];
 f.snapshot.nodeSettings[leaf.id]='old-condition';seed(f);
 const status=getStatus(f.project.id);
 assert.deepEqual(status.staleNodeIds,[f.nodes[1].id]);
 assert.deepEqual(status.unexplainedNodeIds,[f.nodes[0].id,leaf.id]);
});
test('whole coverage complete requires every current node and no source or structure failure',()=>{
 const f=fixture('whole-coverage');f.snapshot.scope='whole_within_current_limits';f.snapshot.structureComplete=true;seed(f);
 assert.equal(getStatus(f.project.id).coverage.scopeKind,'whole');
 assert.equal(getStatus(f.project.id).coverage.complete,true);
 f.snapshot.structureComplete=false;seed(f);assert.equal(getStatus(f.project.id).coverage.complete,false);
});
