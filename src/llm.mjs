import {effectSlotContract,projectEffectSlotOutput} from './focused-effect-slots.mjs';
import {MIN_OUTPUT_TOKENS,MAX_OUTPUT_TOKENS} from './analysis-budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {Agent,Runner,OpenAIResponsesModel,setTracingDisabled} from '@openai/agents';
import {getEncoding} from 'js-tiktoken';
import {z} from 'zod';
import {ROOT,hash} from './parser.mjs';
import {classifyFailure} from './failure-policy.mjs';
import {validateGroupMeaning,validateFocusedGroupMeaning} from './group-meaning.mjs';
import {validateMeaningLanguage} from './meaning-language.mjs';
export const meaningSchema=z.object({id:z.string(),input:z.array(z.string()),process:z.array(z.string()),output:z.array(z.string()),childUses:z.array(z.object({childId:z.string(),description:z.string()}).strict()),uncertainty:z.array(z.string()),evidence:z.array(z.object({line:z.number().int(),claim:z.string()}).strict()),ownerChecks:z.array(z.object({section:z.enum(['input','process','output','childUses']),index:z.number().int().nonnegative(),ownerId:z.string()}).strict())}).strict();
const schema=meaningSchema;
export const groupSchema=z.object({id:z.string(),members:z.array(meaningSchema)}).strict();
// Wire output contains meaning only; canonical stored records retain strict host-owned traces.
export const meaningOutputSchema=meaningSchema.omit({ownerChecks:true}).strict();
export const groupOutputSchema=z.object({id:z.string(),members:z.array(meaningOutputSchema)}).strict();
export function deriveMeaningOwnership(payload,kind){
 const wire=(kind==='dependency_group'?groupOutputSchema:meaningOutputSchema).parse(payload);
 const project=member=>({...member,ownerChecks:['input','process','output','childUses'].flatMap(section=>
  member[section].map((_,index)=>({section,index,ownerId:section==='childUses'?member.childUses[index].childId:member.id}))) });
 return kind==='dependency_group'?groupSchema.parse({...wire,members:wire.members.map(project)}):meaningSchema.parse(project(wire));
}

const encoding=getEncoding('o200k_base');
const MODEL='gpt-6-luna';
export function validateOutputAllocations(allocations,ceiling){
 if(!Number.isInteger(ceiling)||ceiling<MIN_OUTPUT_TOKENS||ceiling>MAX_OUTPUT_TOKENS)throw new Error('Generation output ceiling outside permitted range');
 const token=value=>{if(!Number.isInteger(value)||value<MIN_OUTPUT_TOKENS||value>MAX_OUTPUT_TOKENS||value>ceiling)throw new Error('Generation output allocation outside permitted range');return value;};
 if(allocations===undefined)return undefined;
 if(!allocations||typeof allocations!=='object'||Array.isArray(allocations)||Object.keys(allocations).some(key=>!['default','groups'].includes(key)))throw new Error('Invalid generation output allocations');
 const result={};
 if(allocations.default!==undefined)result.default=token(allocations.default);
 for(const kind of ['groups'])if(allocations[kind]!==undefined){const rows=allocations[kind];if(!rows||typeof rows!=='object'||Array.isArray(rows))throw new Error('Invalid generation output allocation map');result[kind]=Object.fromEntries(Object.entries(rows).map(([id,value])=>{if(!id.trim())throw new Error('Empty generation output allocation ID');return[id,token(value)];}));}
 return result;
}
export function generationOutputPlan(groups,allocations,ceiling){
 allocations=validateOutputAllocations(allocations,ceiling);
 const groupIds=new Set(groups.map(group=>group.id));
 if(Object.keys(allocations?.groups??{}).some(id=>!groupIds.has(id)))throw new Error('Generation output allocation ID outside selected dependency scope');
 return groups.map(group=>{
  const override=allocations?.groups&&Object.hasOwn(allocations.groups,group.id)?allocations.groups[group.id]:undefined;
  return {groupId:group.id,memberIds:group.members.map(node=>node.id),maxOutputTokens:override??allocations?.default??ceiling,status:'pending'};
 });
}
export function validateReasoningAllocations(allocations){
 if(allocations===undefined)return undefined;
 if(!allocations||typeof allocations!=='object'||Array.isArray(allocations)||Object.keys(allocations).some(key=>key!=='groups'))throw new Error('Invalid reasoning allocations');
 if(allocations.groups===undefined)return {};
 const rows=allocations.groups;if(!rows||typeof rows!=='object'||Array.isArray(rows))throw new Error('Invalid reasoning allocation map');
 return {groups:Object.fromEntries(Object.entries(rows).map(([id,effort])=>{if(!id.trim()||!['none','low'].includes(effort))throw new Error('Invalid reasoning allocation');return[id,effort];}))};
}
export function applyReasoningAllocations(plan,groups,allocations){
 allocations=validateReasoningAllocations(allocations);
 const selected=new Map(groups.map(group=>[group.id,group]));
 for(const[id,effort]of Object.entries(allocations?.groups??{})){
  const group=selected.get(id);if(!group)throw new Error('Reasoning allocation ID outside selected dependency scope');
 }
 return plan.map(row=>Object.hasOwn(allocations?.groups??{},row.groupId)?{...row,reasoningEffort:allocations.groups[row.groupId]}:row);
}
export function generationReasoningEffort(effort='none'){
 if(!['none','low'].includes(effort))throw new Error('Invalid generation reasoning effort');return effort;
}
export function permitsProfilelessLegacyCache(profile){return profile.reasoningEffort==='none';}
export function generationOutputLimit(round,allocated){
 const value=allocated??round.plan.limits.maxOutputTokens;
 validateOutputAllocations({default:value},round.plan.limits.maxOutputTokens);
 return value;
}
export function meaningModelSettings(profile){return {maxTokens:profile.maxTokens,reasoning:{effort:profile.reasoningEffort},store:false,retry:{maxRetries:0}};}
export function meaningProfile(kind,maxOutputTokens,effort='none',focus){
 const reasoningEffort=generationReasoningEffort(effort);
 if(focus!==undefined&&(kind!=='dependency_group'||!focus||typeof focus!=='object'||Array.isArray(focus)||Object.keys(focus).some(key=>!['focusMemberId','contextGroupId','inputContextHash'].includes(key))||typeof focus.focusMemberId!=='string'||!focus.focusMemberId.trim()||typeof focus.contextGroupId!=='string'||!focus.contextGroupId.trim()||! /^[a-f0-9]{64}$/.test(focus.inputContextHash??'')))throw new Error('Invalid focused generation profile');
 const dependencies=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).dependencies;
 return {model:MODEL,agentsSDK:dependencies['@openai/agents'],openaiSDK:dependencies.openai,reasoningEffort,maxTurns:1,maxTokens:maxOutputTokens,outputFormat:'strict_json_schema',ownershipTraceOrigin:'host_projection',jsonSchema:z.toJSONSchema(kind==='dependency_group'?groupOutputSchema:meaningOutputSchema),...(focus===undefined?{}:{outputBoundary:'member_focused_v1',...focus})};
}
export function effectSlotMeaningProfile(request,node,maxOutputTokens,effort='none',focusMemberId){
 if(node.kind!=='dependency_group'||!node.members?.some(member=>member.id===focusMemberId))throw new Error('Effect slot focus outside full group');
 const contract=effectSlotContract(request,meaningOutputSchema,focusMemberId),base=meaningProfile(node.kind,maxOutputTokens,effort,{focusMemberId,contextGroupId:node.id,inputContextHash:hash(request.input)});
 return {...base,jsonSchema:contract.sdkSchema,outputBoundary:'member_effect_slots_v1',roleSetHash:hash(contract.roles),requiredRoleIds:contract.roleIds,wireSchemaHash:hash(contract.sdkSchema)};
}
const stopPath=path.join(ROOT,'.local','api-stop.json');
export function clearAPIStop(){if(fs.existsSync(stopPath))fs.unlinkSync(stopPath);}
export class APIFailure extends Error{constructor(record){super('Luna is unavailable; further calls stopped.');this.record=record;}}
export class ModelOutputError extends Error{constructor(record){super('Luna request did not produce a usable complete result: '+record.failureKind);this.record=record;}}
export function usageCost(u){const details=u.inputTokensDetails??[];const cached=details.reduce((n,d)=>n+(d.cached_tokens??d.cachedTokens??0),0);const writes=details.reduce((n,d)=>n+(d.cache_write_tokens??0),0);return (Math.max(0,u.inputTokens-cached-writes)*0.1+cached*0.01+writes*0.125+u.outputTokens*0.5)/1e6;}
export function secretCheck(text){
 if(/\bsk-[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i.test(text))throw new Error('Potential secret in selected analysis input; do not transmit.');
}
function designatedKey(){
 const text=fs.readFileSync(path.join(ROOT,'.env'),'utf8').replace(/^\uFEFF/,'');
 const lines=text.split(/\r?\n/).filter(l=>/^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(l));
 if(lines.length!==1)throw new Error('Designated key missing or ambiguous');
 let key=lines[0].replace(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*/,'').trim();
 if(key.startsWith('"')||key.startsWith("'")){const quote=key[0],end=key.indexOf(quote,1);if(end<0||!/^\s*(?:#.*)?$/.test(key.slice(end+1)))throw new Error('Invalid key format');key=key.slice(1,end);}else key=key.replace(/\s+#.*$/,'').trim();
 if(!key||/\s/.test(key))throw new Error('Invalid key format');return key;
}
export function beginRound(id,options={}){
 const {generationOutputs,...budgets}=options;
 const limits={maxCalls:6,maxInputTokens:3000,maxOutputTokens:1000,...budgets};
 const dir=path.join(ROOT,'.local','rounds',id);fs.mkdirSync(dir,{recursive:true});
 const plan={id,startedAt:new Date().toISOString(),model:MODEL,limits,pricing:{input:0.1,cachedInput:0.01,cacheWrite:0.125,output:0.5,unit:'USD per million',source:'https://developers.openai.com/api/docs/models/gpt-6-luna'},calls:0,stopped:false,...(generationOutputs===undefined?{}:{generationOutputs})};
 const save=()=>fs.writeFileSync(path.join(dir,'budget.json'),JSON.stringify(plan,null,2));save();
 return {dir,plan,save};
}
export async function explain(request,node,children,round,allocation={}){
 const maxOutputTokens=generationOutputLimit(round,allocation.maxOutputTokens);
 if(fs.existsSync(stopPath)){const saved=JSON.parse(fs.readFileSync(stopPath,'utf8'));if(classifyFailure(saved).blocksLuna)throw new APIFailure(saved);fs.renameSync(stopPath,path.join(ROOT,'.local','reclassified-stop-'+Date.now()+'.json'));}
 if(round.plan.stopped)throw new Error('Round stopped after API failure');
 secretCheck(request.input);secretCheck(request.instructions);
 const focusMemberId=allocation.focusMemberId;let focus;
 if(focusMemberId!==undefined){
  if(node.kind!=='dependency_group'||typeof focusMemberId!=='string'||!node.members?.some(member=>member.id===focusMemberId))throw new Error('Focused member outside full group');
  const data=JSON.parse(request.input);if(data.groupId!==node.id||data.focusMemberId!==focusMemberId||data.outputMemberCount!==1||JSON.stringify(data.outputMemberIds)!==JSON.stringify([focusMemberId])||JSON.stringify(data.memberLedgers?.map(member=>member.id))!==JSON.stringify(node.members.map(member=>member.id)))throw new Error('Focused request boundary mismatch');
  focus={focusMemberId,contextGroupId:node.id,inputContextHash:hash(request.input)};
 }
 if(allocation.effectSlots!==undefined&&typeof allocation.effectSlots!=='boolean')throw new Error('Invalid effectSlots option');
 const slots=allocation.effectSlots===true?effectSlotContract(request,meaningOutputSchema,focusMemberId):null;
 if(slots&&!focus)throw new Error('Effect slots require a focused member');
 const profile=slots?effectSlotMeaningProfile(request,node,maxOutputTokens,allocation.reasoningEffort,focusMemberId):meaningProfile(node.kind,maxOutputTokens,allocation.reasoningEffort,focus);
 const outputSchema=slots?slots.wireSchema:node.kind==='dependency_group'?groupOutputSchema:meaningOutputSchema;
 const estimate=encoding.encode(request.instructions+'\n'+request.input+'\n'+JSON.stringify(slots?slots.sdkSchema:z.toJSONSchema(outputSchema))).length+256;
 const zodEstimate=slots?encoding.encode(request.instructions+'\n'+request.input+'\n'+JSON.stringify(slots.zodSchema)).length+256:estimate;
 if(Math.max(estimate,zodEstimate)>round.plan.limits.maxInputTokens)throw new Error('Input exceeds assigned estimated token limit');
 if(round.plan.calls>=round.plan.limits.maxCalls)throw new Error('Assigned call limit reached');
 let key;try{key=designatedKey();}catch{const failure={status:'auth_blocked',reason:'Designated key unavailable or invalid',at:new Date().toISOString()};round.plan.stopped=true;round.save();fs.writeFileSync(stopPath,JSON.stringify(failure));throw new APIFailure(failure);}setTracingDisabled(true);
 let attempts=0;
 const record={...(slots?{roleSetHash:profile.roleSetHash,wireSchemaHash:profile.wireSchemaHash,requiredRoleIds:profile.requiredRoleIds,estimatedZodInputTokens:zodEstimate}:{}),nodeId:node.id,model:MODEL,maxOutputTokens,reasoningEffort:profile.reasoningEffort,...(focus===undefined?{}:{outputBoundary:profile.outputBoundary,...focus}),meaningProfileHash:hash(profile),ownerChecksOrigin:'host_projection',startedAt:new Date().toISOString(),estimatedInputTokens:estimate,inputHash:hash(request),childVersions:children.map(c=>({id:c.id,meaningHash:hash(c)}))};
 const log=()=>fs.appendFileSync(path.join(round.dir,'calls.jsonl'),JSON.stringify(record)+'\n');
 const client=new OpenAI({apiKey:key,baseURL:'https://api.openai.com/v1',organization:null,project:null,maxRetries:0,timeout:45000,
 fetch:async(url,init)=>{
  if(++attempts>1)throw new Error('No retry permitted');round.plan.calls++;round.save();
  try{const effort=JSON.parse(init?.body??'{}').reasoning?.effort;if(['none','low'].includes(effort))record.transportReasoningEffort=effort;}catch{}
  const response=await fetch(url,init);record.httpStatus=response.status;
  try{const body=await response.clone().json();
   if(['completed','incomplete','failed','in_progress'].includes(body.status))record.responseStatus=body.status;
   if(/^[a-zA-Z0-9_-]{1,80}$/.test(body.error?.code??''))record.errorCode=body.error.code;
   const reason=body.incomplete_details?.reason;if(['max_output_tokens','content_filter'].includes(reason))record.incompleteReason=reason;
   const usage=body.usage;if(usage&&Number.isInteger(usage.input_tokens)&&Number.isInteger(usage.output_tokens))record.transportUsage={inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,totalTokens:usage.total_tokens,cachedInputTokens:usage.input_tokens_details?.cached_tokens??0,cacheWriteTokens:usage.input_tokens_details?.cache_write_tokens??0};
  }catch{record.responseMetadata='unavailable';}
  return response;
 }});
 const model=new OpenAIResponsesModel(client,MODEL);
 const agent=new Agent({name:'Phonon meaning',model,instructions:request.instructions,outputType:outputSchema,modelSettings:meaningModelSettings(profile)});
 const runner=new Runner({model,tracingDisabled:true,traceIncludeSensitiveData:false});
 let result;
 try{result=await runner.run(agent,request.input,{maxTurns:profile.maxTurns});}
 catch(error){
  record.errorType=error?.constructor?.name??'Error';
  record.errorCategory=/incomplete|token.*limit|max.*token/i.test(error?.message??'')?'possible_output_limit':/no final|empty.*output|invalid.*output/i.test(error?.message??'')?'invalid_or_missing_output':'unclassified';
  record.httpStatus=Number.isInteger(error?.status)?error.status:(record.httpStatus??null);
  record.errorCode=/^[a-zA-Z0-9_-]{1,80}$/.test(error?.code??'')?error.code:(record.errorCode??null);
  const decision=classifyFailure(record);record.failureKind=decision.kind;record.recoverable=decision.recoverable;
  record.status=decision.blocksLuna?'luna_unavailable':'request_failed';record.actualAttempts=attempts;record.endedAt=new Date().toISOString();
  if(record.transportUsage){const t=record.transportUsage;record.usage={requests:attempts,inputTokens:t.inputTokens,outputTokens:t.outputTokens,totalTokens:t.totalTokens,inputTokensDetails:[{cached_tokens:t.cachedInputTokens,cache_write_tokens:t.cacheWriteTokens}],outputTokensDetails:[]};record.estimatedCostUSD=usageCost(record.usage);}
  if(decision.blocksLuna){round.plan.stopped=true;round.save();fs.writeFileSync(stopPath,JSON.stringify(record,null,2));}
  log();if(decision.blocksLuna)throw new APIFailure(record);throw new ModelOutputError(record);
 }
 record.actualAttempts=attempts;record.usage=result.runContext.usage;
 const u=record.usage;record.estimatedCostUSD=usageCost(u);
 record.endedAt=new Date().toISOString();record.elapsedMs=Date.parse(record.endedAt)-Date.parse(record.startedAt);
 const text=(typeof result.finalOutput==='string'?result.finalOutput:JSON.stringify(result.finalOutput??null)).replace(/^```(?:json)?\s*|\s*```$/g,'');
 try{
  const payload=JSON.parse(text);
  const projection=slots?projectEffectSlotOutput(payload,slots,node.id,focusMemberId):null;
  if(projection){record.effectSlotRawDescriptions=projection.rawSlots;record.effectSlotProjection=projection.audit;}
  const canonical=deriveMeaningOwnership(projection?projection.canonicalWire:payload,node.kind);
  const meaning=node.kind==='dependency_group'?{id:canonical.id,members:focus===undefined?validateGroupMeaning(canonical,node,children):validateFocusedGroupMeaning(canonical,node,children,focusMemberId)}:schema.parse(canonical);
  if(meaning.id!==node.id)throw new Error('Node ID mismatch');
  if(node.kind!=='dependency_group'){
  const expected=new Set(children.map(c=>c.id));
  if(meaning.childUses.some(c=>!expected.has(c.childId))||[...expected].some(id=>!meaning.childUses.some(c=>c.childId===id)))throw new Error('Child IDs mismatch');
  if(meaning.evidence.some(e=>e.line<1||e.line>node.source.split('\n').length))throw new Error('Evidence outside source');
  if(meaning.ownerChecks){
   const checks=z.array(z.object({section:z.enum(['input','process','output','childUses']),index:z.number().int().nonnegative(),ownerId:z.string()})).parse(meaning.ownerChecks);
   for(const section of ['input','process','output','childUses'])for(let index=0;index<meaning[section].length;index++){
    const match=checks.filter(c=>c.section===section&&c.index===index),expectedOwner=section==='childUses'?meaning.childUses[index].childId:node.id;
    if(match.length!==1||match[0].ownerId!==expectedOwner)throw new Error('Ownership coverage or owner mismatch');
   }
   if(checks.some(c=>c.index>=meaning[c.section].length))throw new Error('Ownership reference outside section');
  }
  }
  validateMeaningLanguage(meaning);
  record.status='response_valid';log();
  if(u.inputTokens>round.plan.limits.maxInputTokens){round.plan.stopped=true;round.save();throw new Error('Measured input exceeded token allocation; stop round');}
  return {...meaning,name:node.name};
 }catch(error){if(record.status!=='response_valid'){record.status='quality_failed';record.output=text;record.validationError=error.message;log();}throw error;}
}