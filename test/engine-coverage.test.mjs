import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import vm from 'node:vm';
import {hash} from '../src/parser.mjs';import {registerProject,getStatus,currentAnalysisConditions} from '../src/engine.mjs';import {writeLatest,readLatest} from '../src/state.mjs';import {startUI} from '../src/ui.mjs';import {createPhononServer} from '../src/mcp.mjs';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'.local','test-fixtures-coverage',randomUUID());fs.mkdirSync(source,{recursive:true});const file=path.join(source,'owned.py');fs.writeFileSync(file,'def first(value):\n    return value\n\ndef second(value):\n    return value\n');const project=registerProject('Owned coverage surface fixture',source),conditions=currentAnalysisConditions();
const snapshot={fixtureKind:'synthetic_metadata_not_quality',scope:'partial_with_forward_dependencies_and_reverse_impact',settingsHash:conditions,structureComplete:true,graph:{files:[{file,hash:hash(fs.readFileSync(file,'utf8'))}],nodes:[{id:'first',name:'first',file,language:'python',calls:[],lineMap:[1,2]},{id:'second',name:'second',file,language:'python',calls:[],lineMap:[4,5]}],diagnostics:[]},meanings:{first:{id:'first',input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[]}},nodeSettings:{first:conditions},childVersions:{}};
writeLatest(project.id,snapshot);
test('UI HTTP exposes partial coverage independently of stale explanations and parses its screen script',async()=>{
 const server=await startUI({port:0}),base='http://127.0.0.1:'+server.address().port;
 try{
  const status=await(await fetch(base+'/api/status?id='+project.id)).json();
  assert.equal(status.stale,false);assert.deepEqual(status.staleNodeIds,[]);assert.deepEqual(status.unexplainedNodeIds,['second']);
  assert.equal(status.coverage.explainedNodes,1);assert.equal(status.coverage.unexplainedNodes,1);assert.equal(status.coverage.complete,false);assert.equal(status.coverage.scopeKind,'partial');
  const node=await(await fetch(base+'/api/node?projectId='+project.id+'&nodeId=second')).json();
  assert.equal(node.explanationStatus,'not_generated');assert.equal(node.meaning,null);assert.equal(node.stale,true);assert.equal(node.projectStale,false);
  const html=await(await fetch(base)).text();const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  assert.match(script,/설명 범위/);assert.match(script,/미분석/);assert.match(script,/전체 완료 아님/);
 }finally{await new Promise(resolve=>server.close(resolve));}
 assert.deepEqual(readLatest(project.id),snapshot);
});
test('real MCP analysis_status shares the same coverage fields without replacing partial status',async()=>{
 const server=createPhononServer(),client=new Client({name:'coverage-test',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
  const result=await client.callTool({name:'analysis_status',arguments:{projectId:project.id}});
  assert.ok(!result.isError);const status=JSON.parse(result.content[0].text);
  assert.deepEqual(status.coverage,getStatus(project.id).coverage);assert.deepEqual(status.unexplainedNodeIds,['second']);assert.deepEqual(status.staleNodeIds,[]);
 }finally{await client.close();await server.close();}
 assert.deepEqual(readLatest(project.id),snapshot);
});
