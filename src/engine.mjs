import {MIN_INPUT_TOKENS,MAX_INPUT_TOKENS,DEFAULT_INPUT_TOKENS,MIN_OUTPUT_TOKENS,MAX_OUTPUT_TOKENS,DEFAULT_OUTPUT_TOKENS} from './analysis-budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,VERSION,hash,safeSource,analyzeFiles,requestNode} from './parser.mjs';
import {beginRound,explain,APIFailure,ModelOutputError,meaningProfile,meaningSchema,groupSchema,validateOutputAllocations,generationOutputPlan} from './llm.mjs';
import * as state from './state.mjs';
import {resolveRelations} from './relations.mjs';
import {dependencyGroups} from './dependency-groups.mjs';
import {buildGroupRequest,validateGroupMeaning} from './group-meaning.mjs';
import {validateMeaningLanguage} from './meaning-language.mjs';
import {captureRuntimeConditions,loadedRuntimeConditions,checkRuntimeConditions,assertRuntimeConditions} from './runtime-conditions.mjs';
export const registerProject=state.registerProject,listProjects=state.listProjects;
const allowed=new Set(['.py','.ts','.tsx','.js','.jsx','.html','.css','.sql']);
const ignored=new Set(['node_modules','.git','.venv','venv','.local','.npm-cache','dist','build','TheCodecache']);
const ENGINE_VERSION='engine-2';
function selectedFiles(project,selected){
 if(selected?.length){return selected.map(relative=>{
  const full=fs.realpathSync(path.resolve(project.sourcePath,relative));
  const rel=path.relative(project.sourcePath,full);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Requested source is outside registered project');safeSource(full);return full;
 });}
 const files=[];
 function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink())continue;
  const full=path.join(dir,entry.name);if(entry.isDirectory()){if(!ignored.has(entry.name)&&!entry.name.startsWith('.'))scan(full);}else if(allowed.has(path.extname(entry.name))){files.push(full);}
 }}scan(project.sourcePath);return files.sort();
}
function settings(){
 // Desired disk conditions are distinct from the already loaded host runtime.
 let staticSources,hypothesis;
 try{staticSources=captureRuntimeConditions().fingerprint;}catch(error){staticSources={unavailable:error.code??error.name};}
 try{hypothesis=hash(fs.readFileSync(path.join(ROOT,'experiments/h3.mjs'),'utf8'));}catch(error){hypothesis={unavailable:error.code??error.name};}
 return hash({engine:ENGINE_VERSION,staticSources,hypothesis});
}
export function currentAnalysisConditions(){return settings();}
function readOptional(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function getStatus(id){
 const project=state.getProject(id),dir=state.projectDir(id);
 let latest=null,snapshotError=null;try{latest=state.readLatest(id);}catch{snapshotError={code:'SNAPSHOT_UNREADABLE'};}
 const structure=readOptional(path.join(dir,'structure.json')),snapshot=latest??structure;
 const nodes=snapshot?.graph?.nodes??[],meanings=latest?.meanings??{};
 const runtime=checkRuntimeConditions(),currentSettings=settings();
 let stale=!!snapshotError,changedFiles=[],staleNodeIds=[],inventoryError=null;
 const unexplainedNodeIds=nodes.filter(node=>!meanings[node.id]).map(node=>node.id);
 if(latest){
  for(const f of (latest.graph?.files??[])){try{if(hash(fs.readFileSync(f.file,'utf8'))!==f.hash)changedFiles.push(f.file);}catch{changedFiles.push(f.file);}}
  try{const current=selectedFiles(project),old=new Set((latest.graph?.files??[]).map(f=>f.file));for(const f of current)if(!old.has(f))changedFiles.push(f);}catch(error){inventoryError=error.message;}
  const changed=new Set(changedFiles);
  // Missing explanations are incomplete coverage, not old explanations.
  // They still invalidate an existing caller that depends on that missing meaning.
  const affected=new Set([...unexplainedNodeIds,...nodes.filter(n=>changed.has(n.file)||(latest.nodeSettings?.[n.id]??latest.settingsHash)!==currentSettings||(latest.staleRetainedNodeIds??[]).includes(n.id)||(latest.nodeSourceHashes?.[n.id]!==undefined&&latest.nodeSourceHashes[n.id]!==hash(n.source??''))).map(n=>n.id)]);
  const reverse=new Map();
  for(const node of nodes)for(const target of dependencyIds(node)){
   if(!reverse.has(target))reverse.set(target,new Set());reverse.get(target).add(node.id);
  }
  const queue=[...affected];for(let i=0;i<queue.length;i++)for(const caller of reverse.get(queue[i])??[]){if(!affected.has(caller)){affected.add(caller);queue.push(caller);}}
  staleNodeIds=nodes.filter(node=>meanings[node.id]&&affected.has(node.id)).map(node=>node.id);
  stale=changedFiles.length>0||staleNodeIds.length>0||!!inventoryError;
 }
 const explainedNodes=nodes.length-unexplainedNodeIds.length;
 const scope=latest?.scope??'not_generated';
 const coverage={totalNodes:nodes.length,explainedNodes,currentExplainedNodes:explainedNodes-staleNodeIds.length,staleExplainedNodes:staleNodeIds.length,unexplainedNodes:unexplainedNodeIds.length,
  scope,scopeKind:scope.startsWith('partial')?'partial':scope.startsWith('whole')?'whole':'unknown',
  structureComplete:snapshot?.structureComplete??(snapshot?.graph?!(snapshot.graph.diagnostics??[]).length:false),
  complete:!!latest&&nodes.length>0&&unexplainedNodeIds.length===0&&staleNodeIds.length===0&&changedFiles.length===0&&!inventoryError&&latest.structureComplete!==false&&!(latest.graph?.diagnostics??[]).length};
 const failureFiles=fs.existsSync(path.join(dir,'failures'))?fs.readdirSync(path.join(dir,'failures')).sort():[];
 return {project,stale,snapshotError,changedFiles,staleNodeIds,unexplainedNodeIds,coverage,inventoryError,restartRequired:runtime.restartRequired,runtime,desiredConditions:currentSettings,latest,structure,recentFailure:failureFiles.length?readOptional(path.join(dir,'failures',failureFiles.at(-1))):null,job:state.readJob(id),limits:{context:'registered_project_static_structure',meaningBudget:'request_call_and_token_limits',crossFile:'explicit_static_imports_within_analyzed_scope',cycles:'confirmed_SCC_joint_meaning',quality:'generated descriptions require review'}};
}
export function getNode(id,nodeId){
 const status=getStatus(id),snapshot=status.latest??status.structure;
 const node=snapshot?.graph.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('Node not present in available analysis');
 const meaning=snapshot.meanings?.[nodeId],meaningSource=meaning?(snapshot.meaningSources?.[nodeId]??{file:node.file,source:node.source,lineMap:node.lineMap}):null;
 return {node,meaning:meaning?{...meaning,evidence:meaning.evidence.map(e=>({...e,line:meaningSource.lineMap?.[e.line-1]??e.line}))}:null,meaningSource,explanationStatus:!meaning?'not_generated':status.staleNodeIds.includes(nodeId)?'stale':'current',stale:status.staleNodeIds.includes(nodeId)||!meaning,projectStale:status.stale,job:status.job,childVersions:snapshot.childVersions?.[nodeId]??[]};
}
export function requestAnalysis(id,options={}){
 assertRuntimeConditions();
 state.getProject(id);
 const maxCalls=options.maxCalls??0,maxInputTokens=options.maxInputTokens??DEFAULT_INPUT_TOKENS,maxOutputTokens=options.maxOutputTokens??DEFAULT_OUTPUT_TOKENS;
 if(!Number.isInteger(maxCalls)||maxCalls<0||maxCalls>24||!Number.isInteger(maxInputTokens)||maxInputTokens<MIN_INPUT_TOKENS||maxInputTokens>MAX_INPUT_TOKENS||!Number.isInteger(maxOutputTokens)||maxOutputTokens<MIN_OUTPUT_TOKENS||maxOutputTokens>MAX_OUTPUT_TOKENS)throw new Error('Analysis budget outside permitted range');
 if(options.nodeIds!==undefined&&(!Array.isArray(options.nodeIds)||options.nodeIds.some(id=>typeof id!=='string'||!id.trim())))throw new Error('nodeIds must be an array of nonempty node identifiers');
 const outputAllocations=validateOutputAllocations(options.outputAllocations,maxOutputTokens);
 const existing=state.readJob(id);
 if(existing?.status==='queued'||existing?.status==='running')return existing;
 const lock=state.acquireLock(id);
 const job={jobId:lock.token,jobToken:lock.token,ownerPID:process.pid,ownerStartId:lock.ownerStartId,status:'queued',queuedAt:new Date().toISOString(),processed:0};
 try{state.writeJob(id,job);}catch(error){state.releaseLock(id);throw error;}
 setImmediate(()=>runAnalysis(id,{...options,maxCalls,maxInputTokens,maxOutputTokens,outputAllocations},job));return state.readJob(id);
}
export async function waitForJob(id){
 let shared=state.readJob(id);
 while(shared?.status==='queued'||shared?.status==='running'){await new Promise(resolve=>setTimeout(resolve,50));shared=state.readJob(id);}
 return shared;
}
const dependencyIds=node=>[...new Set([...(node.calls??[]),...(node.references??[])].map(edge=>edge.targetId).filter(Boolean))];
function relationSignature(node){return hash({calls:(node.calls??[]).map(c=>({name:c.name,targetId:c.targetId,status:c.status,reason:c.relationReason})),references:(node.references??[]).map(r=>({targetId:r.targetId,kind:r.kind,field:r.field,access:r.access}))});}
function analysisScope(graph,previous,files,partial,nodeIds=[]){
 const byId=new Map(graph.nodes.map(n=>[n.id,n]));
 if(!partial)return new Set(byId.keys());
 const selected=new Set(files),impacted=new Set([...graph.nodes.filter(n=>selected.has(n.file)).map(n=>n.id),...nodeIds]);
 for(const node of previous?.graph?.nodes??[])if(selected.has(node.file))impacted.add(node.id);
 const oldById=new Map((previous?.graph?.nodes??[]).map(n=>[n.id,n]));
 // Barrel edits/deletions can change resolved targets without creating a callable barrel node.
 // Include these structural changes rather than retaining obsolete confirmed relationships.
 for(const node of graph.nodes){const old=oldById.get(node.id);if(old&&previous?.meanings?.[node.id]&&relationSignature(old)!==relationSignature(node))impacted.add(node.id);}
 const reverse=new Map();
 for(const node of [...graph.nodes,...(previous?.graph?.nodes??[])])for(const target of dependencyIds(node)){
  if(!reverse.has(target))reverse.set(target,new Set());reverse.get(target).add(node.id);
 }
 const impactQueue=[...impacted];for(let i=0;i<impactQueue.length;i++)for(const caller of reverse.get(impactQueue[i])??[]){if(previous?.meanings?.[caller]&&!impacted.has(caller)){impacted.add(caller);impactQueue.push(caller);}}
 const needed=new Set([...impacted].filter(id=>byId.has(id))),queue=[...needed];
 for(let i=0;i<queue.length;i++)for(const target of dependencyIds(byId.get(queue[i]))){if(byId.has(target)&&!needed.has(target)){needed.add(target);queue.push(target);}}
 return needed;
}
function validateCachedMeaning(raw,node,children){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Cached meaning must be an object');
 let payload;
 if(node.kind==='dependency_group'){
  // explain attaches an undefined host name to a group; JSON persistence omits it.
  const candidate={...raw};if(candidate.name===undefined)delete candidate.name;
  payload=groupSchema.parse(candidate);validateGroupMeaning(payload,node,children);
 }else{
  // name is host display metadata, not part of the strict model response schema.
  const {name:hostName,...candidate}=raw;payload=meaningSchema.parse(candidate);
  if(payload.id!==node.id)throw new Error('Cached node ID mismatch');
  const required=new Set(children.map(child=>child.id)),seen=new Set();
  for(const use of payload.childUses){if(!required.has(use.childId)||seen.has(use.childId))throw new Error('Cached child IDs mismatch');seen.add(use.childId);}
  if(seen.size!==required.size)throw new Error('Cached child coverage incomplete');
  if(payload.evidence.some(e=>e.line<node.startLine||e.line>node.endLine))throw new Error('Cached evidence outside source');
  const sections=['input','process','output','childUses'],checks=payload.ownerChecks;
  for(const section of sections)for(let index=0;index<payload[section].length;index++){
   const match=checks.filter(check=>check.section===section&&check.index===index),owner=section==='childUses'?payload.childUses[index].childId:node.id;
   if(match.length!==1||match[0].ownerId!==owner)throw new Error('Cached ownership coverage mismatch');
  }
  if(checks.some(check=>check.index>=payload[check.section].length))throw new Error('Cached ownership reference outside section');
 }
 validateMeaningLanguage(payload);
 return node.kind==='dependency_group'?payload:{...payload,name:node.name};
}
async function runAnalysis(id,options,job){
 let locked=true,previous,setupComplete=false;
 try{
  state.assertLockOwner(id,job.jobToken);assertRuntimeConditions();job.status='running';job.startedAt=new Date().toISOString();state.writeJob(id,job);
  const project=state.getProject(id);previous=state.readLatest(id);setupComplete=true;
  const analysisSettings=settings(),runtimeFingerprint=loadedRuntimeConditions.fingerprint;
  const requestedFiles=selectedFiles(project,options.files);
  if(!requestedFiles.length)throw new Error('No supported sources in requested scope');
  // Structural context is the entire registered project; paid meaning scope remains bounded.
  // Retain incomplete context diagnostics without inventing targets from unreadable files.
  const contextFiles=options.files?.length?selectedFiles(project):requestedFiles;
  const graph=await analyzeFiles(contextFiles);
  const dir=state.projectDir(id),partial=!!options.files?.length||!!options.nodeIds?.length;
  fs.writeFileSync(path.join(dir,'structure.json'),JSON.stringify({graph,dependencyGroups:[],selectedNodeIds:[],meanings:{},qualityStatus:graph.diagnostics.length?'stage12_incomplete':'stage12_only',structureComplete:graph.diagnostics.length===0,completedAt:new Date().toISOString()},null,2));
  if(!partial&&graph.diagnostics.length)throw new Error('Source graph diagnostics: '+JSON.stringify(graph.diagnostics));
  const explicitlySelectedFiles=new Set(options.files?.length?requestedFiles:[]);
  if(graph.diagnostics.some(diagnostic=>diagnostic.status==='parse_failed'&&explicitlySelectedFiles.has(diagnostic.file)))throw new Error('Requested file source graph diagnostics: '+JSON.stringify(graph.diagnostics.filter(diagnostic=>explicitlySelectedFiles.has(diagnostic.file))));
  await resolveRelations(graph,{projectRoot:project.sourcePath});
  graph.parserLimits=[...(graph.limits??[])];
  graph.limits=['Explicit same-file and static import/reexport relations are confirmed only within analyzed project files; dynamic targets and external implementations remain unverified.','Confirmed calls and state references use dependency-first SCC groups; recursive members are explained jointly, without inventing a semantic hierarchy.','HTML uses root elements, CSS uses rules, and SQL uses a parsed file unit; cross-language relationships remain unverified.'];
  const requestedNodeIds=[...new Set(options.nodeIds??[])],availableNodeIds=new Set(graph.nodes.map(node=>node.id));
  if(requestedNodeIds.some(nodeId=>!availableNodeIds.has(nodeId)))throw new Error('Requested node ID is not present in current project graph');
  const scopeFiles=options.files?.length?requestedFiles:requestedNodeIds.length?[]:requestedFiles;
  const groups=dependencyGroups(graph),needed=analysisScope(graph,previous,scopeFiles,partial,requestedNodeIds);
  const ordered=groups.filter(group=>group.members.some(node=>needed.has(node.id)));
  for(const group of ordered)for(const node of group.members)needed.add(node.id);
  const groupStructure=groups.map(({id,members,cyclic,dependencies})=>({id,members:members.map(n=>n.id),cyclic,dependencies}));
  fs.writeFileSync(path.join(dir,'structure.json'),JSON.stringify({graph,dependencyGroups:groupStructure,selectedNodeIds:[...needed],meanings:{},qualityStatus:graph.diagnostics.length?'stage12_partial_with_diagnostics':'stage12_only',structureComplete:graph.diagnostics.length===0,completedAt:new Date().toISOString()},null,2));
  const promptPath=path.join(ROOT,'experiments/h3.mjs'),promptHash=hash(fs.readFileSync(promptPath,'utf8'));
  const hypothesis=await import(pathToFileURL(promptPath).href+'?version='+promptHash);
  const generationOutputs=generationOutputPlan(ordered,options.outputAllocations,options.maxOutputTokens);
  const round=beginRound(job.jobId,{maxCalls:options.maxCalls,maxInputTokens:options.maxInputTokens,maxOutputTokens:options.maxOutputTokens,generationOutputs});
  const meanings={},childVersions={},nodeSettings={},nodeSourceHashes={},meaningSources={},cacheDir=path.join(dir,'cache','h3');fs.mkdirSync(cacheDir,{recursive:true});
  const reused=[],generated=[],cacheMigrations=[],cacheRejected=[];
  const previousNodes=new Map((previous?.graph?.nodes??[]).map(node=>[node.id,node]));
  if(partial&&previous)for(const node of graph.nodes){
   if(needed.has(node.id)||!previous.meanings?.[node.id])continue;
   meanings[node.id]=previous.meanings[node.id];childVersions[node.id]=previous.childVersions?.[node.id]??[];
   nodeSettings[node.id]=previous.nodeSettings?.[node.id]??previous.settingsHash;
   nodeSourceHashes[node.id]=previous.nodeSourceHashes?.[node.id]??hash(previousNodes.get(node.id)?.source??'');
   const original=previousNodes.get(node.id);meaningSources[node.id]=previous.meaningSources?.[node.id]??{file:original?.file,source:original?.source,lineMap:original?.lineMap};
  }
  for(const group of ordered){
   const memberIds=new Set(group.members.map(n=>n.id));
   const externalIds=[...new Set(group.members.flatMap(dependencyIds))].filter(childId=>!memberIds.has(childId));
   const children=externalIds.map(childId=>meanings[childId]);
   if(children.some(c=>!c))throw new Error('Confirmed child meaning unavailable');
   const normalized=group.cyclic?{id:group.id,kind:'dependency_group',members:group.members.map(requestNode)}:requestNode(group.members[0]);
   const request=group.cyclic?buildGroupRequest(normalized,children):hypothesis.buildRequest(normalized,children);
   const allocation=generationOutputs.find(row=>row.groupId===group.id);
   const profile=meaningProfile(normalized.kind,allocation.maxOutputTokens);
   allocation.meaningProfileHash=hash(profile);round.save();
   const identity={request,meaningProfile:profile};
   const cacheKey=hash(identity),requestHash=hash(request),cachePath=path.join(cacheDir,cacheKey+'.json');
   let meaning;
   function loadCompatible(file,expectedKey,requireProof=false){
    try{
     const cached=readOptional(file);if(!cached)return null;
     if(requireProof && (cached.requestHash!==requestHash || cached.meaningProfile===undefined))throw new Error('Cached request/profile proof missing');
     if(cached.cacheKey!==expectedKey || cached.requestHash!==undefined && cached.requestHash!==requestHash || cached.meaningProfile!==undefined && hash(cached.meaningProfile)!==hash(profile))throw new Error('Cached request identity mismatch');
     return validateCachedMeaning(cached.meaning,normalized,children);
    }catch(error){cacheRejected.push({cacheKey:expectedKey,groupId:group.id,reason:error instanceof Error?error.name:'validation_failure'});job.cacheRejected=cacheRejected.length;return null;}
   }
   meaning=loadCompatible(cachePath,cacheKey,true);
   if(!meaning){
    // Profile-era caches may include raw loader/audit hashes in their old key.
    // Only exact request SHA plus exact profile SHA proves compatibility here.
    const candidates=fs.readdirSync(cacheDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name)&&entry.name!==cacheKey+'.json').map(entry=>entry.name).sort();
    for(const candidate of candidates){
     const file=path.join(cacheDir,candidate);let header;
     try{header=readOptional(file);}catch{continue;}
     if(!header || header.requestHash!==requestHash || header.meaningProfile===undefined || hash(header.meaningProfile)!==hash(profile))continue;
     const priorKey=candidate.slice(0,-5);meaning=loadCompatible(file,priorKey,true);
     if(!meaning)continue;
     fs.writeFileSync(cachePath,JSON.stringify({cacheKey,requestHash,meaningProfile:profile,meaning,migratedFrom:priorKey,audit:{promptHash,parserVersion:VERSION,analysisConditions:analysisSettings,runtimeFingerprint}},null,2));
     cacheMigrations.push({legacyKey:priorKey,cacheKey,memberIds:[...memberIds],proof:'exact_request_and_profile_hash'});break;
    }
   }
   if(!meaning&&previous?.settingsHash){
    // The old key is reconstructed from this exact request, never found by ID or glob.
    const legacyKey=hash({request,model:'gpt-6-luna',parserVersion:VERSION,promptHash,maxOutputTokens:allocation.maxOutputTokens,conditions:previous.settingsHash});
    meaning=loadCompatible(path.join(cacheDir,legacyKey+'.json'),legacyKey);
    if(meaning){
     fs.writeFileSync(cachePath,JSON.stringify({cacheKey,requestHash,meaningProfile:profile,meaning,migratedFrom:legacyKey,audit:{promptHash,parserVersion:VERSION,analysisConditions:analysisSettings,runtimeFingerprint}},null,2));
     cacheMigrations.push({legacyKey,cacheKey,memberIds:[...memberIds]});
    }
   }
   if(meaning){reused.push(...memberIds);allocation.status='reused';round.save();}
   else{
    if(round.plan.calls>=options.maxCalls)throw new Error('Meaning generation requires additional allocated calls; old successful snapshot preserved');
    state.assertLockOwner(id,job.jobToken);
    meaning=validateCachedMeaning(await explain(request,normalized,children,round,{maxOutputTokens:allocation.maxOutputTokens}),normalized,children);
    fs.writeFileSync(cachePath,JSON.stringify({cacheKey,requestHash,meaningProfile:profile,meaning,audit:{promptHash,parserVersion:VERSION,analysisConditions:analysisSettings,runtimeFingerprint}},null,2));generated.push(...memberIds);allocation.status='generated';round.save();
   }
   if(group.cyclic)for(const member of meaning.members){const source=group.members.find(n=>n.id===member.id);meanings[member.id]={...member,name:source.name};}
   else meanings[group.members[0].id]=meaning;
   for(const node of group.members){
    childVersions[node.id]=dependencyIds(node).map(childId=>({id:childId,meaningHash:hash(meanings[childId])}));
    nodeSettings[node.id]=analysisSettings;nodeSourceHashes[node.id]=hash(node.source??'');meaningSources[node.id]={file:node.file,source:node.source,lineMap:node.lineMap};job.processed++;job.reused=reused.length;job.generated=generated.length;state.writeJob(id,job);
   }
  }
  const staleRetainedNodeIds=[];
  if(partial&&previous){
   const currentIds=new Set(graph.nodes.map(node=>node.id)),selected=new Set(requestedFiles);
   for(const old of previous.graph.nodes??[]){
    if(currentIds.has(old.id)||selected.has(old.file))continue;
    graph.nodes.push({...old,staleRetained:true});staleRetainedNodeIds.push(old.id);
    if(!graph.files.some(file=>file.file===old.file)){const oldFile=previous.graph.files.find(file=>file.file===old.file);if(oldFile)graph.files.push(oldFile);}
    if(previous.meanings?.[old.id])meanings[old.id]=previous.meanings[old.id];
    childVersions[old.id]=previous.childVersions?.[old.id]??[];
    nodeSettings[old.id]=previous.nodeSettings?.[old.id]??previous.settingsHash;
    nodeSourceHashes[old.id]=previous.nodeSourceHashes?.[old.id]??hash(old.source??'');
    meaningSources[old.id]=previous.meaningSources?.[old.id]??{file:old.file,source:old.source,lineMap:old.lineMap};
   }
  }
  const snapshot={graph,dependencyGroups:groupStructure,meanings,childVersions,nodeSettings,nodeSourceHashes,meaningSources,staleRetainedNodeIds,settingsHash:analysisSettings,runtimeFingerprint,completedAt:new Date().toISOString(),scope:partial?'partial_with_forward_dependencies_and_reverse_impact':'whole_within_current_limits',requestedFiles:scopeFiles,requestedNodeIds,analyzedNodeIds:[...needed],qualityStatus:'generated_review_required',structureComplete:graph.diagnostics.length===0,reused,generated,cacheMigrations,cacheRejected,generationOutputs,roundId:job.jobId};
  assertRuntimeConditions();
  if(settings()!==analysisSettings)throw new Error('Analysis conditions changed during execution; previous successful snapshot preserved');
  state.assertLockOwner(id,job.jobToken);state.writeLatest(id,snapshot);job.status='completed';job.reused=reused.length;job.generated=generated.length;job.qualityStatus=snapshot.qualityStatus;job.cacheMigrations=cacheMigrations.length;job.cacheRejected=cacheRejected.length;
 }catch(error){job.status=error instanceof APIFailure?'api_blocked':'failed';job.reason=(error instanceof APIFailure||error instanceof ModelOutputError)?error.record:error.message;
  job.failureCode=error instanceof APIFailure?'API_BLOCKED':error instanceof ModelOutputError?'MODEL_OUTPUT_FAILED':error.code==='RUNTIME_RESTART_REQUIRED'?'RUNTIME_RESTART_REQUIRED':!setupComplete?'STATE_READ_FAILED':'ANALYSIS_FAILED';
  const message=error instanceof Error?error.message:'';
  job.publicReason=message.startsWith('Meaning generation requires')?'Meaning generation requires additional allocated calls; old successful snapshot preserved':message.startsWith('Requested file source graph diagnostics')?'Requested file source graph diagnostics':message.startsWith('Source graph diagnostics')?'Source graph diagnostics':message.startsWith('Requested node ID')?'Requested node ID is not present in current project graph':error.code==='RUNTIME_RESTART_REQUIRED'?'분석 프로그램 코드가 변경되어 다시 시작이 필요합니다.':!setupComplete?'Stored analysis snapshot could not be read; damaged state preserved without repair.':'Analysis failed; check preserved failure record.';
  try{state.assertLockOwner(id,job.jobToken);state.writeFailure(id,{jobId:job.jobId,status:job.status,reason:job.reason,at:new Date().toISOString(),previousSuccessfulSnapshotPreserved:!!previous});}catch{job.status='unknown';}
 }finally{
  job.endedAt=new Date().toISOString();
  if(locked){try{state.writeJob(id,job);}catch{job.status='unknown';}try{state.releaseLock(id);}catch{}}
 }
}
