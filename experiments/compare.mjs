import fs from 'node:fs';
import path from 'node:path';
import {ROOT,analyzeFiles,dependencyOrder,requestNode,hash} from '../src/parser.mjs';
import {beginRound,explain,APIFailure} from '../src/llm.mjs';
const file=process.argv[2];if(!file)throw new Error('Provide a reviewed read-only Python source with add and its top-level caller.');
const graph=await analyzeFiles([file]);
if(graph.diagnostics.length)throw new Error(JSON.stringify(graph.diagnostics));
const nodes=dependencyOrder(graph);
if(nodes.length!==2)throw new Error('First common test must contain exactly two nodes');
const round=beginRound('initial-'+Date.now(),{maxCalls:6,maxInputTokens:3000,maxOutputTokens:1000});
fs.writeFileSync(path.join(round.dir,'graph.json'),JSON.stringify(graph,null,2));
for(const id of ['h1','h2','h3']){
 const mod=await import(`./${id}.mjs`),meanings=new Map(),results=[];
 fs.writeFileSync(path.join(round.dir,id+'-plan.json'),JSON.stringify({hypothesis:mod.hypothesis,sourceHash:graph.files[0].hash,expected:['add returns a+b','top_level supplies 2 and 3 to add then prints result','parent does not repeat addition internals'],callAllocation:2},null,2));
 for(const node of nodes){
  const children=[...new Set(node.calls.map(c=>c.targetId).filter(Boolean))].map(id=>meanings.get(id));
  if(children.some(c=>!c)){results.push({nodeId:node.id,status:'blocked_by_child'});continue;}
  const normalized=requestNode(node),request=mod.buildRequest(normalized,children);
  fs.writeFileSync(path.join(round.dir,`${id}-${hash(node.id).slice(0,8)}-request.json`),JSON.stringify(request,null,2));
  try{const meaning=await explain(request,normalized,children,round);meanings.set(node.id,meaning);results.push({nodeId:node.id,status:'generated',meaning});}
  catch(error){results.push({nodeId:node.id,status:error instanceof APIFailure?'api_failed':'quality_failed',reason:error instanceof APIFailure?error.record:error.message});fs.writeFileSync(path.join(round.dir,id+'-results.json'),JSON.stringify(results,null,2));if(error instanceof APIFailure||round.plan.stopped)throw error;}
 }
 fs.writeFileSync(path.join(round.dir,id+'-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({id,results},null,2));
}
console.log(JSON.stringify({roundDirectory:round.dir,budget:round.plan},null,2));