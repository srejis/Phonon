import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,VERSION,hash,safeSource,analyzeFiles,dependencyOrder,requestNode} from './parser.mjs';
import {beginRound,explain,APIFailure} from './llm.mjs';
import * as state from './state.mjs';
export const registerProject=state.registerProject,listProjects=state.listProjects;
const jobs=new Map();
const allowed=new Set(['.py','.ts','.tsx','.js','.jsx','.html','.css','.sql']);
const ignored=new Set(['node_modules','.git','.venv','venv','.local','.npm-cache','dist','build','TheCodecache']);
const ENGINE_VERSION='engine-1';
function selectedFiles(project,selected){
 if(selected?.length){if(selected.length>64)throw new Error('Scope exceeds 64 files');return selected.map(relative=>{
  const full=fs.realpathSync(path.resolve(project.sourcePath,relative));
  const rel=path.relative(project.sourcePath,full);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Requested source is outside registered project');safeSource(full);return full;
 });}
 const files=[];
 function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink())continue;
  const full=path.join(dir,entry.name);if(entry.isDirectory()){if(!ignored.has(entry.name)&&!entry.name.startsWith('.'))scan(full);}else if(allowed.has(path.extname(entry.name))){files.push(full);if(files.length>64)throw new Error('Project exceeds initial 64-file limit; request an explicit smaller scope');}
 }}scan(project.sourcePath);return files.sort();
}
function settings(){return hash({engine:ENGINE_VERSION,parser:fs.readFileSync(path.join(ROOT,'src/parser.mjs'),'utf8'),llm:fs.readFileSync(path.join(ROOT,'src/llm.mjs'),'utf8'),hypothesis:fs.readFileSync(path.join(ROOT,'experiments/h3.mjs'),'utf8')});}
function readOptional(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function getStatus(id){
 const project=state.getProject(id),latest=state.readLatest(id),dir=state.projectDir(id);
 let stale=!latest||latest.settingsHash!==settings(),changedFiles=[];
 if(latest)for(const f of (latest.graph?.files??[])){try{if(hash(fs.readFileSync(f.file,'utf8'))!==f.hash){stale=true;changedFiles.push(f.file);}}catch{stale=true;changedFiles.push(f.file);}}
 const failureFiles=fs.existsSync(path.join(dir,'failures'))?fs.readdirSync(path.join(dir,'failures')).sort():[];
 return {project,stale,changedFiles,latest,structure:readOptional(path.join(dir,'structure.json')),recentFailure:failureFiles.length?readOptional(path.join(dir,'failures',failureFiles.at(-1))):null,job:jobs.get(id)??null,limits:{files:64,nodes:100,crossFile:'unresolved',cycles:'blocked_pending_verified_SCC_strategy',quality:'generated descriptions require review'}};
}
export function getNode(id,nodeId){
 const status=getStatus(id),snapshot=status.latest??status.structure;
 const node=snapshot?.graph.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('Node not present in available analysis');
 const meaning=snapshot.meanings?.[nodeId];
 return {node,meaning:meaning?{...meaning,evidence:meaning.evidence.map(e=>({...e,line:node.lineMap[e.line-1]??e.line}))}:null,stale:status.stale,childVersions:snapshot.childVersions?.[nodeId]??[]};
}
export function requestAnalysis(id,options={}){
 state.getProject(id);
 if(jobs.get(id)?.status==='running')return jobs.get(id);
 const maxCalls=options.maxCalls??0,maxInputTokens=options.maxInputTokens??3000,maxOutputTokens=options.maxOutputTokens??1000;
 if(!Number.isInteger(maxCalls)||maxCalls<0||maxCalls>24||!Number.isInteger(maxInputTokens)||maxInputTokens<256||maxInputTokens>6000||!Number.isInteger(maxOutputTokens)||maxOutputTokens<64||maxOutputTokens>2000)throw new Error('Analysis budget outside permitted range');
 const job={jobId:hash(id+Date.now()).slice(0,16),status:'running',startedAt:new Date().toISOString(),processed:0};jobs.set(id,job);
 setImmediate(()=>runAnalysis(id,{...options,maxCalls,maxInputTokens,maxOutputTokens},job));return {...job};
}
export async function waitForJob(id){while(jobs.get(id)?.status==='running')await new Promise(resolve=>setTimeout(resolve,50));return jobs.get(id);}
async function runAnalysis(id,options,job){
 let locked=false;const project=state.getProject(id),previous=state.readLatest(id);
 try{
  state.acquireLock(id);locked=true;
  const files=selectedFiles(project,options.files);if(!files.length)throw new Error('No supported sources in requested scope');
  const graph=await analyzeFiles(files);if(graph.nodes.length>100)throw new Error('Scope exceeds initial 100-node limit');
  if(graph.diagnostics.length)throw new Error('Source graph diagnostics: '+JSON.stringify(graph.diagnostics));
  const order=dependencyOrder(graph),dir=state.projectDir(id);
  fs.writeFileSync(path.join(dir,'structure.json'),JSON.stringify({graph,meanings:{},qualityStatus:'stage12_only',completedAt:new Date().toISOString()},null,2));
  const promptPath=path.join(ROOT,'experiments/h3.mjs'),promptHash=hash(fs.readFileSync(promptPath,'utf8'));
  const hypothesis=await import(pathToFileURL(promptPath).href+'?version='+promptHash);
  const round=beginRound(job.jobId,{maxCalls:options.maxCalls,maxInputTokens:options.maxInputTokens,maxOutputTokens:options.maxOutputTokens});
  const meanings={},childVersions={},cacheDir=path.join(dir,'cache','h3');fs.mkdirSync(cacheDir,{recursive:true});
  const reused=[],generated=[];
  for(const node of order){
   const children=[...new Set(node.calls.map(c=>c.targetId).filter(Boolean))].map(childId=>meanings[childId]);
   if(children.some(c=>!c))throw new Error('Confirmed child meaning unavailable');
   const normalized=requestNode(node),request=hypothesis.buildRequest(normalized,children);
   const cacheKey=hash({request,model:'gpt-6-luna',parserVersion:VERSION,promptHash,maxOutputTokens:options.maxOutputTokens});
   const cachePath=path.join(cacheDir,cacheKey+'.json'),cached=readOptional(cachePath);
   if(cached){meanings[node.id]=cached.meaning;reused.push(node.id);}else{
    if(round.plan.calls>=options.maxCalls)throw new Error('Meaning generation requires additional allocated calls; old successful snapshot preserved');
    const meaning=await explain(request,normalized,children,round);meanings[node.id]=meaning;
    fs.writeFileSync(cachePath,JSON.stringify({cacheKey,meaning},null,2));generated.push(node.id);
   }
   childVersions[node.id]=children.map(child=>({id:child.id,meaningHash:hash(child)}));job.processed++;
  }
  const snapshot={graph,meanings,childVersions,settingsHash:settings(),completedAt:new Date().toISOString(),scope:options.files?'partial':'whole_within_current_limits',qualityStatus:'generated_review_required',reused,generated,roundId:job.jobId};
  if(previous&&options.files){
   const selected=new Set(files),untouched=previous.graph.nodes.filter(n=>!selected.has(n.file));
   const previousNodes=previous.graph.nodes.filter(n=>selected.has(n.file));
   const changedIds=new Set([...previousNodes.map(n=>n.id),...graph.nodes.map(n=>n.id)]);
   const outsideDependants=untouched.filter(n=>n.calls.some(c=>changedIds.has(c.targetId)));
   if(outsideDependants.length)throw new Error('Partial scope affects a node outside the selected scope; include that source before promotion');
   snapshot.graph.nodes=[...untouched,...graph.nodes];snapshot.graph.files=[...previous.graph.files.filter(f=>!selected.has(f.file)),...graph.files];
   for(const node of untouched){snapshot.meanings[node.id]=previous.meanings[node.id];snapshot.childVersions[node.id]=previous.childVersions?.[node.id]??[];}
  }
  state.writeLatest(id,snapshot);job.status='completed';job.reused=reused.length;job.generated=generated.length;job.qualityStatus=snapshot.qualityStatus;
 }catch(error){job.status=error instanceof APIFailure?'api_blocked':'failed';job.reason=error instanceof APIFailure?error.record:error.message;
  state.writeFailure(id,{jobId:job.jobId,status:job.status,reason:job.reason,at:new Date().toISOString(),previousSuccessfulSnapshotPreserved:!!previous});
 }finally{job.endedAt=new Date().toISOString();if(locked)state.releaseLock(id);}
}