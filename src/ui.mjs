import http from 'node:http';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {registerProject,listProjects,getStatus,requestAnalysis,getNode} from './engine.mjs';

const MAX_BODY=16*1024;
function clean(value){
 if(typeof value==='string')return value.replace(/sk-[A-Za-z0-9_-]{12,}/g,'[비밀값 숨김]').replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/g,'[비밀값 숨김]').replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [비밀값 숨김]').replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[비밀키 숨김]').replace(/((?:OPENAI_API_KEY|password|api_key|secret)\s*[:=]\s*["'])[^"]*?["']/gi,'$1[비밀값 숨김]"');
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(?:apiKey|api_key|password|secret|token|env|environment|authorization)$/i.test(key)).map(([key,item])=>[key,clean(item)]));
 return value;
}
function localRequest(req){
 try{
  const host=new URL('http://'+req.headers.host);
  if(host.username||host.password||!['127.0.0.1','localhost'].includes(host.hostname)||Number(host.port||80)!==req.socket.localPort)return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(req.headers.origin){const origin=new URL(req.headers.origin);if(origin.protocol!=='http:'||origin.host!==host.host)return false;}
  return true;
 }catch{return false;}
}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(clean(value)));}
async function body(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw Object.assign(new Error(),{status:415});
 if(Number(req.headers['content-length'])>MAX_BODY)throw Object.assign(new Error(),{status:413});
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error(),{status:413});chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(new Error(),{status:400});}
}
function bounded(value,min,max,fallback){const n=value===undefined?fallback:value;if(!Number.isInteger(n)||n<min||n>max)throw Object.assign(new Error(),{status:400});return n;}
function required(value){if(typeof value!=='string'||!value.trim()||value.length>4096)throw Object.assign(new Error(),{status:400});return value;}

const PAGE=String.raw`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phonon 검수</title><style>body{font:15px system-ui;max-width:1100px;margin:28px auto;padding:0 18px;color:#18202a;background:#f6f7fa}section{background:white;padding:18px;margin:14px 0;border:1px solid #dce0e6;border-radius:8px}label{display:inline-block;margin:6px 8px 6px 0}input,select,button,textarea{font:inherit;padding:7px;max-width:100%;box-sizing:border-box}button{cursor:pointer}textarea{width:100%;height:65px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f7;padding:10px}li{margin:6px 0}#notice{white-space:pre-wrap;color:#8a290b}#nodeSelect{min-width:220px;width:100%}.grid{display:grid;grid-template-columns:1fr 2fr;gap:14px}@media(max-width:700px){.grid{grid-template-columns:1fr}}h1{font-size:24px}h2{font-size:18px}h3{font-size:16px}</style></head><body><h1>Phonon 최소 검수 화면</h1><p>프로젝트의 설명과 원본 근거를 확인합니다. 분석 호출은 외부 API를 사용할 수 있습니다.</p><div role="status" id="notice" aria-live="polite"></div><section><h2>프로젝트</h2><form id="register"><label>이름 <input id="projectName" required maxlength="200"></label><label>로컬 경로 <input id="projectPath" required size="45"></label><button>등록</button></form><label>등록 프로젝트 <select id="projectSelect"><option value="">선택하세요</option></select></label><button id="refresh" type="button">상태 새로고침</button><pre id="status">프로젝트를 선택하세요.</pre><details><summary>상태 상세 기록</summary><pre id="statusDetails"></pre></details></section><section><h2>분석 요청</h2><form id="analyze"><label>최대 API 호출 <input id="maxCalls" type="number" min="0" max="24" value="0" required></label><label>입력 토큰 한도 <input id="maxInput" type="number" min="256" max="6000" value="3000" required></label><label>출력 토큰 한도 <input id="maxOutput" type="number" min="64" max="2000" value="1000" required></label><label for="files">파일 범위: 한 줄에 하나. 비우면 엔진의 등록 프로젝트 범위를 사용합니다.</label><textarea id="files" placeholder="선택적으로 파일 경로 입력"></textarea><button>지정한 한도로 분석 요청</button></form><p>기본 호출 한도는 0입니다. 호출 수를 입력한 뒤 요청 버튼을 눌러야 분석을 요청합니다.</p></section><div class="grid"><section><h2>노드 선택</h2><select id="nodeSelect" size="12" aria-label="분석 노드"></select><h3>미해결·변경 상태</h3><pre id="nodeState">선택된 노드가 없습니다.</pre></section><section><h2 id="nodeTitle">노드 설명</h2><h3>입력</h3><ul id="input"></ul><h3>처리</h3><ul id="process"></ul><h3>출력</h3><ul id="output"></ul><h3>불확실성</h3><ul id="uncertainty"></ul><h3>하위 설명 탐색</h3><div id="children"></div><h3>원본 근거</h3><ul id="evidence"></ul><pre id="source"></pre></section></div><script nonce="__NONCE__">
const $=id=>document.getElementById(id);let projectId='',snapshot=null,nodeById=new Map(),timer=null,selectedId='';
function message(text){$('notice').textContent=text;}
async function api(url,data){const response=await fetch(url,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error||'요청 실패');return value;}
function list(id,items){const target=$(id);target.replaceChildren();for(const item of items||[]){const li=document.createElement('li');li.textContent=typeof item==='string'?item:JSON.stringify(item);target.append(li);}}
function clearNode(){selectedId='';$('nodeTitle').textContent='노드 설명';for(const id of ['input','process','output','uncertainty','evidence','children'])$(id).replaceChildren();$('source').textContent='';$('nodeState').textContent='선택된 노드가 없습니다.';}
async function projects(prefer){const result=await api('/api/projects');const rows=Array.isArray(result)?result:result.projects||[];const target=$('projectSelect');target.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='선택하세요';target.append(blank);for(const p of rows){const opt=document.createElement('option');opt.value=p.id||p.projectId;opt.textContent=p.name+' · '+(p.sourcePath||p.path||p.root||'');target.append(opt);}target.value=prefer||projectId;projectId=target.value;}
function jobLabel(status){return ({running:'분석 중',queued:'대기 중',completed:'완료',failed:'실패 · 마지막 정상 결과 보존',api_blocked:'API 실패 · 분석 중단'})[status]||'대기 · 실행 중인 요청 없음';}
function failureLabel(reason){const text=typeof reason==='string'?reason:JSON.stringify(reason);if(/additional allocated calls|allocated.*calls|budget|call.*limit/i.test(text))return '지정 호출 한도로 새 설명을 만들 수 없습니다. 기존 정상 결과는 보존됩니다.';if(/group meaning/i.test(text))return '순환 그룹의 설명 형식 또는 근거 검증을 통과하지 못했습니다.';if(/diagnostics|parse|syntax/i.test(text))return '소스 구문 또는 노드 식별 문제를 확인해야 합니다.';if(/64.file|100.node|scope exceeds|outside.*scope/i.test(text))return '분석 범위가 한도를 넘거나 추가 파일 확인이 필요합니다.';if(/No supported sources/i.test(text))return '요청 범위에 지원하는 소스 파일이 없습니다.';if(/API|authentication|quota|billing|connection|key/i.test(text))return '모델 접근 또는 API 요청이 실패해 분석을 중단했습니다.';return '분석을 완료하지 못했습니다. 자세한 원인은 상세 기록에서 확인하세요.';}
function snapshotOf(status){return status.latest||status.structure||status.snapshot||status;}
async function loadStatus(){if(!projectId)return;const id=projectId;const status=await api('/api/status?id='+encodeURIComponent(id));if(id!==projectId)return;snapshot=snapshotOf(status);const graph=snapshot.graph||status.graph||{nodes:[]};nodeById=new Map((graph.nodes||[]).map(n=>[n.id,n]));const job=status.job||{};const stale=status.stale||snapshot.stale||status.outdated||false;const failure=status.recentFailure;const changed=status.changedFiles||status.changed||status.changes||snapshot.changes||[];const counts={reused:Number.isInteger(job.reused)?job.reused:Array.isArray(snapshot.reused)?snapshot.reused.length:'미확인',generated:Number.isInteger(job.generated)?job.generated:Array.isArray(snapshot.generated)?snapshot.generated.length:'미확인'};const projectName=status.project?.name||$('projectSelect').selectedOptions[0]?.textContent||id;const issue=job.reason||failure?.reason;$('status').textContent=['프로젝트: '+projectName,'최신성: '+(!snapshot.graph?'아직 분석 기록 없음':stale?'오래된 결과 · 재확인 필요':'최신 결과'),'실행: '+jobLabel(job.status),'노드: '+nodeById.size+'개','재사용: '+counts.reused+'개 · 갱신: '+counts.generated+'개','설명: '+(Object.keys(snapshot.meanings||{}).length?'생성 결과는 원본과 비교 검수 필요':'아직 생성된 설명 없음'),changed.length?'변경 파일: '+changed.length+'개':'변경 감지: 없음',issue?'최근 실패: '+failureLabel(issue):'최근 실패: 없음','분석 범위: 명시적 파일 간 연결과 순환 그룹 · 동적/언어 간 연결은 미확인'].join('\n');$('statusDetails').textContent=JSON.stringify({projectId:id,job,stale,changed,recentFailure:failure||null,diagnostics:graph.diagnostics||[],limits:graph.limits||[],engineLimits:status.limits||{}},null,2);const target=$('nodeSelect');target.replaceChildren();for(const n of nodeById.values()){const opt=document.createElement('option');opt.value=n.id;opt.textContent=n.name+' · '+n.language;target.append(opt);}if(nodeById.has(selectedId)){target.value=selectedId;await showNode(selectedId);}else clearNode();clearTimeout(timer);if(['running','queued'].includes(job.status)||status.status==='running')timer=setTimeout(()=>loadStatus().catch(e=>message(e.message)),2000);}
async function showNode(id){if(!id||!projectId)return;const requestedProject=projectId;const result=await api('/api/node?projectId='+encodeURIComponent(projectId)+'&nodeId='+encodeURIComponent(id));if(requestedProject!==projectId)return;const node=result.node||nodeById.get(id)||result;const meaning=result.meaning||result.description||(snapshot.meanings||{})[id]||{};selectedId=id;$('nodeSelect').value=id;$('nodeTitle').textContent=node.name||id;for(const key of ['input','process','output','uncertainty'])list(key,meaning[key]);list('evidence',(meaning.evidence||[]).map(e=>'줄 '+e.line+': '+e.claim));const origin=result.meaningSource||node;const lines=String(origin.source||'').split('\n');$('source').textContent=(origin.file||node.file||'')+'\n'+(result.stale?'설명 생성 당시 원본 · 현재 결과는 재확인 필요':'설명 근거 원본')+'\n'+lines.map((line,index)=>(origin.lineMap?.[index]??index+1)+' | '+line).join('\n');const unresolved=(node.calls||[]).filter(c=>!c.targetId&&c.status!=='standard_builtin_contract');$('nodeState').textContent=['최신성: '+((result.stale??snapshot.stale)?'오래된 결과 · 재확인 필요':'최신 결과'),'프로젝트: '+(result.projectStale?'다른 변경도 재확인 필요':'최신 결과'),'설명: '+(meaning.id?'생성됨 · 검수 필요':'아직 없음'),'미해결 호출: '+unresolved.length+'개',...unresolved.map(call=>'· '+call.name+' (줄 '+call.line+')')].join('\n');$('children').replaceChildren();const refs=new Map();for(const child of meaning.childUses||[])refs.set(child.childId,child.description);for(const edge of [...(node.calls||[]),...(node.references||[])])if(edge.targetId&&!refs.has(edge.targetId))refs.set(edge.targetId,edge.name||edge.field||'상태 참조');for(const [childId,text]of refs){const line=document.createElement('p'),button=document.createElement('button');button.type='button';button.textContent=(nodeById.get(childId)||{}).name||childId;button.addEventListener('click',()=>showNode(childId).catch(e=>message(e.message)));line.append(button,document.createTextNode(' '+text));$('children').append(line);}}
$('register').addEventListener('submit',async event=>{event.preventDefault();try{const result=await api('/api/projects',{name:$('projectName').value,path:$('projectPath').value});await projects(result.id||result.projectId);message('등록했습니다.');await loadStatus();}catch(e){message(e.message);}});
$('projectSelect').addEventListener('change',()=>{clearTimeout(timer);projectId=$('projectSelect').value;snapshot=null;nodeById.clear();clearNode();$('nodeSelect').replaceChildren();$('status').textContent='프로젝트를 선택하세요.';if(projectId)loadStatus().catch(e=>message(e.message));});
$('refresh').addEventListener('click',()=>loadStatus().catch(e=>message(e.message)));
$('nodeSelect').addEventListener('change',()=>showNode($('nodeSelect').value).catch(e=>message(e.message)));
$('analyze').addEventListener('submit',async event=>{event.preventDefault();if(!projectId){message('프로젝트를 먼저 선택하세요.');return;}try{const files=$('files').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);const result=await api('/api/analyze',{projectId,files:files.length?files:undefined,maxCalls:Number($('maxCalls').value),maxInputTokens:Number($('maxInput').value),maxOutputTokens:Number($('maxOutput').value)});message('분석 요청을 접수했습니다. '+jobLabel(result.status));await loadStatus();}catch(e){message(e.message);}});
projects().catch(e=>message(e.message));
</script></body></html>`;

export async function startUI({port=4317}={}){
 bounded(port,0,65535,4317);
 const server=http.createServer(async(req,res)=>{
  if(!localRequest(req)){reply(res,403,{error:'로컬 주소의 요청만 허용합니다.'});return;}
  try{
   const url=new URL(req.url,'http://127.0.0.1');
   if(req.method==='GET'&&url.pathname==='/'){
    const nonce=crypto.randomBytes(18).toString('base64');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(PAGE.replace('__NONCE__',nonce));return;
   }
   if(req.method==='GET'&&url.pathname==='/api/projects'){reply(res,200,await listProjects());return;}
   if(req.method==='POST'&&url.pathname==='/api/projects'){const value=await body(req);reply(res,201,await registerProject(required(value.name),required(value.path)));return;}
   if(req.method==='GET'&&url.pathname==='/api/status'){reply(res,200,await getStatus(required(url.searchParams.get('id'))));return;}
   if(req.method==='GET'&&url.pathname==='/api/node'){reply(res,200,await getNode(required(url.searchParams.get('projectId')),required(url.searchParams.get('nodeId'))));return;}
   if(req.method==='POST'&&url.pathname==='/api/analyze'){
    const value=await body(req),projectId=required(value.projectId);
    const options={maxCalls:bounded(value.maxCalls,0,24,0),maxInputTokens:bounded(value.maxInputTokens,256,6000,3000),maxOutputTokens:bounded(value.maxOutputTokens,64,2000,1000)};
    if(value.files!==undefined){if(!Array.isArray(value.files)||value.files.length>64)throw Object.assign(new Error(),{status:400});options.files=value.files.map(required);}
    reply(res,202,await requestAnalysis(projectId,options));return;
   }
   reply(res,404,{error:'요청 경로를 찾을 수 없습니다.'});
  }catch(error){reply(res,error.status||500,{error:error.status===413?'요청 본문은 16KB 이하여야 합니다.':error.status===415?'JSON 요청만 허용합니다.':error.status===400?'요청 값 또는 호출 한도를 확인하세요.':'엔진 요청이 실패했습니다. 프로젝트 상태에서 실패 여부를 확인하세요.'});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=await startUI();console.log('Phonon UI: http://127.0.0.1:'+server.address().port);
}


