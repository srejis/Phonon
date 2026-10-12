import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {MIN_INPUT_TOKENS,MAX_INPUT_TOKENS,DEFAULT_INPUT_TOKENS} from '../src/analysis-budget.mjs';
import {registerProject,requestAnalysis,waitForJob} from '../src/engine.mjs';import {startUI} from '../src/ui.mjs';import {createPhononServer} from '../src/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'.local','test-fixtures-budget',randomUUID());fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'a.py'),'def identity(value):\n    return value\n');const project=registerProject('Owned input budget fixture',source);
const recorded=job=>JSON.parse(fs.readFileSync(path.join(root,'.local','rounds',job.jobId,'budget.json'),'utf8'));
async function engineBudget(input){requestAnalysis(project.id,{maxCalls:0,...(input===undefined?{}:{maxInputTokens:input})});const job=await waitForJob(project.id);assert.equal(job.status,'failed');assert.match(job.reason,/additional allocated calls/);const budget=recorded(job);assert.equal(budget.calls,0);return budget;}

test('engine input range is 256..16000 with default 3000 and unchanged call/output bounds',async()=>{
 assert.equal(MIN_INPUT_TOKENS,256);assert.equal(MAX_INPUT_TOKENS,16000);assert.equal(DEFAULT_INPUT_TOKENS,3000);
 for(const input of [256,8000,16000])assert.equal((await engineBudget(input)).limits.maxInputTokens,input);
 const defaults=await engineBudget();assert.equal(defaults.limits.maxInputTokens,3000);assert.equal(defaults.limits.maxOutputTokens,1000);assert.equal(defaults.limits.maxCalls,0);
 for(const options of [{maxInputTokens:255},{maxInputTokens:16001},{maxInputTokens:8000.5},{maxCalls:-1},{maxCalls:25},{maxOutputTokens:63},{maxOutputTokens:2001}])assert.throws(()=>requestAnalysis(project.id,options),/budget outside/);
});
test('MCP schema and validated tool arguments share 16000 ceiling without widening paid/output limits',async()=>{
 let seen;const engine={requestAnalysis:(_id,options)=>{seen=options;return{jobId:'mock',status:'running'};}};
 const server=createPhononServer(engine),client=new Client({name:'budget-test',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{const tool=(await client.listTools()).tools.find(t=>t.name==='request_analysis');assert.equal(tool.inputSchema.properties.maxInputTokens.maximum,16000);assert.equal(tool.inputSchema.properties.maxCalls.maximum,24);assert.equal(tool.inputSchema.properties.maxOutputTokens.maximum,2000);
 const result=await client.callTool({name:'request_analysis',arguments:{projectId:'fixture',maxInputTokens:16000}});assert.ok(!result.isError);assert.equal(seen.maxCalls,0);assert.equal(seen.maxInputTokens,16000);
 const invalid=await client.callTool({name:'request_analysis',arguments:{projectId:'fixture',maxInputTokens:16001}});assert.equal(invalid.isError,true);
 }finally{await client.close();await server.close();}
});
test('UI rendered input range and HTTP handler accept 16000 and reject 16001',async()=>{
 const server=await startUI({port:0}),base='http://127.0.0.1:'+server.address().port;
 try{const html=await(await fetch(base)).text();assert.match(html,/id="maxInput"[^>]*min="256" max="16000" value="3000"/);
 const send=input=>fetch(base+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,maxCalls:0,maxInputTokens:input})});
 const invalid=await send(16001);assert.equal(invalid.status,400);const valid=await send(16000);assert.equal(valid.status,202);await valid.json();const job=await waitForJob(project.id);assert.equal(recorded(job).limits.maxInputTokens,16000);assert.equal(recorded(job).calls,0);
 }finally{await new Promise(r=>server.close(r));}
});
test('actual CLI forwards 16000 to the shared engine with zero model calls',()=>{
 const result=spawnSync(process.execPath,['cli.mjs','analyze',project.id,'0','--input-tokens=16000'],{cwd:root,encoding:'utf8'});const job=JSON.parse(result.stdout);assert.equal(result.status,1);assert.match(job.reason,/additional allocated calls/);const budget=recorded(job);assert.equal(budget.limits.maxInputTokens,16000);assert.equal(budget.calls,0);
});
