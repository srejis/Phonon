import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {Agent,Runner,OpenAIResponsesModel,setTracingDisabled} from '@openai/agents';
import {getEncoding} from 'js-tiktoken';
import {z} from 'zod';
import {ROOT,hash} from './parser.mjs';
import {classifyFailure} from './failure-policy.mjs';
import {validateGroupMeaning} from './group-meaning.mjs';
import {validateMeaningLanguage} from './meaning-language.mjs';
export const meaningSchema=z.object({id:z.string(),input:z.array(z.string()),process:z.array(z.string()),output:z.array(z.string()),childUses:z.array(z.object({childId:z.string(),description:z.string()}).strict()),uncertainty:z.array(z.string()),evidence:z.array(z.object({line:z.number().int(),claim:z.string()}).strict()),ownerChecks:z.array(z.object({section:z.enum(['input','process','output','childUses']),index:z.number().int().nonnegative(),ownerId:z.string()}).strict())}).strict();
const schema=meaningSchema;
export const groupSchema=z.object({id:z.string(),members:z.array(meaningSchema)}).strict();
const encoding=getEncoding('o200k_base');
const MODEL='gpt-6-luna';
export function meaningProfile(kind,maxOutputTokens){
 const dependencies=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).dependencies;
 return {model:MODEL,agentsSDK:dependencies['@openai/agents'],openaiSDK:dependencies.openai,reasoningEffort:'none',maxTurns:1,maxTokens:maxOutputTokens,outputFormat:'strict_json_schema',jsonSchema:z.toJSONSchema(kind==='dependency_group'?groupSchema:meaningSchema)};
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
 const limits={maxCalls:6,maxInputTokens:3000,maxOutputTokens:1000,...options};
 const dir=path.join(ROOT,'.local','rounds',id);fs.mkdirSync(dir,{recursive:true});
 const plan={id,startedAt:new Date().toISOString(),model:MODEL,limits,pricing:{input:0.1,cachedInput:0.01,cacheWrite:0.125,output:0.5,unit:'USD per million',source:'https://developers.openai.com/api/docs/models/gpt-6-luna'},calls:0,stopped:false};
 const save=()=>fs.writeFileSync(path.join(dir,'budget.json'),JSON.stringify(plan,null,2));save();
 return {dir,plan,save};
}
export async function explain(request,node,children,round){
 if(fs.existsSync(stopPath)){const saved=JSON.parse(fs.readFileSync(stopPath,'utf8'));if(classifyFailure(saved).blocksLuna)throw new APIFailure(saved);fs.renameSync(stopPath,path.join(ROOT,'.local','reclassified-stop-'+Date.now()+'.json'));}
 if(round.plan.stopped)throw new Error('Round stopped after API failure');
 secretCheck(request.input);secretCheck(request.instructions);
 const profile=meaningProfile(node.kind,round.plan.limits.maxOutputTokens);
 const outputSchema=node.kind==='dependency_group'?groupSchema:schema;
 const estimate=encoding.encode(request.instructions+'\n'+request.input+'\n'+JSON.stringify(z.toJSONSchema(outputSchema))).length+256;
 if(estimate>round.plan.limits.maxInputTokens)throw new Error('Input exceeds assigned estimated token limit');
 if(round.plan.calls>=round.plan.limits.maxCalls)throw new Error('Assigned call limit reached');
 let key;try{key=designatedKey();}catch{const failure={status:'auth_blocked',reason:'Designated key unavailable or invalid',at:new Date().toISOString()};round.plan.stopped=true;round.save();fs.writeFileSync(stopPath,JSON.stringify(failure));throw new APIFailure(failure);}setTracingDisabled(true);
 let attempts=0;
 const record={nodeId:node.id,model:MODEL,startedAt:new Date().toISOString(),estimatedInputTokens:estimate,inputHash:hash(request),childVersions:children.map(c=>({id:c.id,meaningHash:hash(c)}))};
 const log=()=>fs.appendFileSync(path.join(round.dir,'calls.jsonl'),JSON.stringify(record)+'\n');
 const client=new OpenAI({apiKey:key,baseURL:'https://api.openai.com/v1',organization:null,project:null,maxRetries:0,timeout:45000,
 fetch:async(url,init)=>{
  if(++attempts>1)throw new Error('No retry permitted');round.plan.calls++;round.save();
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
 const agent=new Agent({name:'Phonon meaning',model,instructions:request.instructions,outputType:outputSchema,modelSettings:{maxTokens:profile.maxTokens,reasoning:{effort:profile.reasoningEffort},store:false,retry:{maxRetries:0}}});
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
  const meaning=node.kind==='dependency_group'?{id:node.id,members:validateGroupMeaning(payload,node,children)}:schema.parse(payload);
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