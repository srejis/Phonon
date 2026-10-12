import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {Agent, Runner, OpenAIResponsesModel, setTracingDisabled} from '@openai/agents';
const root = path.resolve(import.meta.dirname, '..');
const keyPath = path.join(root, '.env');
const record = {startedAt:new Date().toISOString(), model:'gpt-6-luna', maxCalls:1, maxOutputTokens:64, sdk:'@openai/agents 0.20.0', keySource:keyPath};
const logDir = path.join(root, '.local');
fs.mkdirSync(logDir, {recursive:true});
let attempts = 0;
try {
  const env = fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/, '');
  const matches = env.split(/\r?\n/).filter(line=>/^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line));
  if(matches.length!==1) throw Object.assign(new Error(),{code:'designated_key_missing_or_ambiguous'});
  let apiKey=matches[0].replace(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*/, '').trim();
  if(apiKey.startsWith('"') || apiKey.startsWith("'")) {
    const quote=apiKey[0], end=apiKey.indexOf(quote,1);
    if(end<0 || !/^\s*(?:#.*)?$/.test(apiKey.slice(end+1))) throw Object.assign(new Error(),{code:'invalid_designated_key_format'});
    apiKey=apiKey.slice(1,end);
  } else apiKey=apiKey.replace(/\s+#.*$/, '').trim();
  if(!apiKey || /\s/.test(apiKey)) throw Object.assign(new Error(),{code:'invalid_designated_key_format'});
  setTracingDisabled(true);
  const client = new OpenAI({apiKey, baseURL:'https://api.openai.com/v1', organization:null, project:null, maxRetries:0, timeout:30000,
    fetch:async (url,init)=>{if(++attempts>1) throw Object.assign(new Error(),{code:'call_limit'}); return fetch(url,init);}});
  const model = new OpenAIResponsesModel(client,'gpt-6-luna');
  const agent = new Agent({name:'Phonon preflight',instructions:'Reply exactly OK.',model,modelSettings:{maxTokens:64,reasoning:{effort:'none'},store:false,retry:{maxRetries:0}}});
  const runner=new Runner({model,tracingDisabled:true,traceIncludeSensitiveData:false});
  const result=await runner.run(agent,'Connection check.',{maxTurns:1});
  record.status='success'; record.responseMatches=String(result.finalOutput).trim()==='OK';
  record.usage=result.runContext.usage;
} catch(error) {
  record.status='blocked'; record.errorType=error?.constructor?.name ?? 'Error';
  record.httpStatus=Number.isInteger(error?.status)?error.status:null;
  record.errorCode=/^[a-zA-Z0-9_\-]{1,80}$/.test(error?.code ?? '')?error.code:null;
  process.exitCode=1;
}
record.actualAttempts=attempts; record.endedAt=new Date().toISOString();
fs.writeFileSync(path.join(logDir,'preflight.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify(record,null,2));