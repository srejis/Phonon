import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {Agent,Runner,OpenAIResponsesModel,setTracingDisabled} from '@openai/agents';
import {getEncoding} from 'js-tiktoken';
import {z} from 'zod';
import {ROOT,hash} from './parser.mjs';
const schema=z.object({id:z.string(),input:z.array(z.string()),process:z.array(z.string()),output:z.array(z.string()),childUses:z.array(z.object({childId:z.string(),description:z.string()})),uncertainty:z.array(z.string()),evidence:z.array(z.object({line:z.number().int(),claim:z.string()}))}).passthrough();
const encoding=getEncoding('o200k_base');
const MODEL='gpt-6-luna';
const stopPath=path.join(ROOT,'.local','api-stop.json');
export function clearAPIStop(){if(fs.existsSync(stopPath))fs.unlinkSync(stopPath);}
export class APIFailure extends Error{constructor(record){super('Luna API failed; further calls stopped.');this.record=record;}}
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
 const plan={id,startedAt:new Date().toISOString(),model:MODEL,limits,pricing:{input:0.1,cachedInput:0.01,output:0.5,unit:'USD per million',source:'https://developers.openai.com/api/docs/models/gpt-6-luna'},calls:0,stopped:false};
 const save=()=>fs.writeFileSync(path.join(dir,'budget.json'),JSON.stringify(plan,null,2));save();
 return {dir,plan,save};
}
export async function explain(request,node,children,round){
 if(fs.existsSync(stopPath))throw new APIFailure({status:'api_blocked',reason:'Persistent API stop requires explicit user confirmation before resume'});
 if(round.plan.stopped)throw new Error('Round stopped after API failure');
 secretCheck(request.input);secretCheck(request.instructions);
 const estimate=encoding.encode(request.instructions+'\n'+request.input).length+256;
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
   const reason=body.incomplete_details?.reason;if(['max_output_tokens','content_filter'].includes(reason))record.incompleteReason=reason;
   const usage=body.usage;if(usage&&Number.isInteger(usage.input_tokens)&&Number.isInteger(usage.output_tokens))record.transportUsage={inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,totalTokens:usage.total_tokens,cachedInputTokens:usage.input_tokens_details?.cached_tokens??0};
  }catch{record.responseMetadata='unavailable';}
  return response;
 }});
 const model=new OpenAIResponsesModel(client,MODEL);
 const agent=new Agent({name:'Phonon meaning',model,instructions:request.instructions,modelSettings:{maxTokens:round.plan.limits.maxOutputTokens,reasoning:{effort:'none'},store:false,retry:{maxRetries:0}}});
 const runner=new Runner({model,tracingDisabled:true,traceIncludeSensitiveData:false});
 let result;
 try{result=await runner.run(agent,request.input,{maxTurns:1});}
 catch(error){round.plan.stopped=true;round.save();record.status='api_failed';record.errorType=error?.constructor?.name??'Error';record.errorCategory=/incomplete|token.*limit|max.*token/i.test(error?.message??'')?'possible_output_limit':/no final|empty.*output|invalid.*output/i.test(error?.message??'')?'invalid_or_missing_output':'unclassified';record.httpStatus=Number.isInteger(error?.status)?error.status:null;record.errorCode=/^[a-zA-Z0-9_-]{1,80}$/.test(error?.code??'')?error.code:null;record.actualAttempts=attempts;record.endedAt=new Date().toISOString();log();fs.writeFileSync(stopPath,JSON.stringify(record,null,2));throw new APIFailure(record);}
 record.actualAttempts=attempts;record.usage=result.runContext.usage;
 const u=record.usage,cached=(u.inputTokensDetails??[]).reduce((sum,d)=>sum+(d.cached_tokens??d.cachedTokens??0),0);
 record.estimatedCostUSD=((u.inputTokens-cached)*0.1+cached*0.01+u.outputTokens*0.5)/1e6;
 record.endedAt=new Date().toISOString();record.elapsedMs=Date.parse(record.endedAt)-Date.parse(record.startedAt);
 const text=String(result.finalOutput??'').replace(/^```(?:json)?\s*|\s*```$/g,'');
 try{
  const meaning=schema.parse(JSON.parse(text));
  if(meaning.id!==node.id)throw new Error('Node ID mismatch');
  const expected=new Set(children.map(c=>c.id));
  if(meaning.childUses.some(c=>!expected.has(c.childId))||[...expected].some(id=>!meaning.childUses.some(c=>c.childId===id)))throw new Error('Child IDs mismatch');
  if(meaning.evidence.some(e=>e.line<1||e.line>node.source.split('\n').length))throw new Error('Evidence outside source');
  record.status='response_valid';log();
  if(u.inputTokens>round.plan.limits.maxInputTokens){round.plan.stopped=true;round.save();throw new Error('Measured input exceeded token allocation; stop round');}
  return {...meaning,name:node.name};
 }catch(error){if(record.status!=='response_valid'){record.status='quality_failed';record.output=text;record.validationError=error.message;log();}throw error;}
}