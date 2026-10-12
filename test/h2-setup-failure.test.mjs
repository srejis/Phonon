import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {registerProject,getStatus} from '../src/engine.mjs';import {projectDir,writeLatest,readLatest,readJob} from '../src/state.mjs';import {startUI} from '../src/ui.mjs';import {createPhononServer} from '../src/mcp.mjs';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const root=path.resolve(import.meta.dirname,'..');
function fixture(){const source=path.join(root,'.local','test-fixtures-h2-setup',randomUUID());fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'owned.py'),'def identity(value):\n    return value\n');const p=registerProject('Owned H2 setup failure',source),dir=projectDir(p.id);fs.mkdirSync(dir,{recursive:true});return{project:p,dir};}
function run(f){return spawnSync(process.execPath,['cli.mjs','analyze',f.project.id,'0'],{cwd:root,encoding:'utf8'});}
test('corrupt latest read becomes shared failed job, releases own lock and leaves bytes untouched',async()=>{
 const f=fixture(),file=path.join(f.dir,'latest.json'),damaged='{broken-owned-latest';fs.writeFileSync(file,damaged);
 const producer=run(f);assert.equal(producer.status,1);assert.equal(producer.stderr,'');const job=JSON.parse(producer.stdout);
 assert.equal(job.status,'failed');assert.equal(job.failureCode,'STATE_READ_FAILED');assert.equal(job.processed,0);
 assert.deepEqual(readJob(f.project.id),job);assert.equal(fs.readFileSync(file,'utf8'),damaged);assert.ok(!fs.existsSync(path.join(f.dir,'run.lock')));
 assert.ok(fs.existsSync(path.join(f.dir,'jobs',job.jobId+'.json')));assert.ok(!fs.existsSync(path.join(root,'.local','rounds',job.jobId,'budget.json')));
 const failures=fs.readdirSync(path.join(f.dir,'failures'));assert.equal(failures.length,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'failures',failures[0]),'utf8')).previousSuccessfulSnapshotPreserved,false);
 const status=getStatus(f.project.id);assert.equal(status.latest,null);assert.deepEqual(status.snapshotError,{code:'SNAPSHOT_UNREADABLE'});assert.equal(status.coverage.complete,false);assert.equal(status.job.status,'failed');assert.equal(status.stale,true);
 assert.ok(!JSON.stringify(status.job).includes('broken-owned-latest'));
 const ui=await startUI({port:0});try{const s=await(await fetch('http://127.0.0.1:'+ui.address().port+'/api/status?id='+f.project.id)).json();assert.equal(s.job.status,'failed');assert.equal(s.snapshotError.code,'SNAPSHOT_UNREADABLE');assert.equal(s.latest,null);}finally{await new Promise(r=>ui.close(r));}
 const mcp=createPhononServer(),client=new Client({name:'h2-corrupt-latest',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await mcp.connect(st);await client.connect(ct);
 try{const response=await client.callTool({name:'analysis_status',arguments:{projectId:f.project.id}});assert.ok(!response.isError);const s=JSON.parse(response.content[0].text);assert.equal(s.job.status,'failed');assert.equal(s.snapshotError.code,'SNAPSHOT_UNREADABLE');assert.equal(s.latest,null);}finally{await client.close();await mcp.close();}
 assert.equal(fs.readFileSync(file,'utf8'),damaged);
});
test('healthy old snapshot survives ordinary zero-call budget failure without a snapshot read error',()=>{
 const f=fixture(),good={fixtureKind:'synthetic_old_good_not_quality',graph:{nodes:[],files:[],diagnostics:[]},meanings:{},settingsHash:'owned-old-conditions'};
 writeLatest(f.project.id,good);const producer=run(f);assert.equal(producer.status,1);assert.equal(producer.stderr,'');const job=JSON.parse(producer.stdout);
 assert.equal(job.status,'failed');assert.equal(job.failureCode,'ANALYSIS_FAILED');assert.match(job.reason,/additional allocated calls/);assert.deepEqual(readLatest(f.project.id),good);
 assert.equal(getStatus(f.project.id).snapshotError,null);assert.ok(!fs.existsSync(path.join(f.dir,'run.lock')));
 const budget=JSON.parse(fs.readFileSync(path.join(root,'.local','rounds',job.jobId,'budget.json'),'utf8'));assert.equal(budget.calls,0);
});
