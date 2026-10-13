import test from 'node:test';import assert from 'node:assert/strict';import {buildRequest,hypothesis} from '../experiments/h3.mjs';
const contracts=[{name:'parent.mkdir',effects:['디렉터리 생성 요청'],source:'official-contract-a',assumption:'조건부'}, {name:'temporary.unlink',effects:['파일 삭제 요청'],source:'official-contract-b',assumption:'조건부'}, {name:'copy',effects:['파일 복사 요청'],source:'official-contract-c',assumption:'조건부'}, {name:'replace',effects:['경로 교체 요청'],source:'official-contract-d',assumption:'조건부'}];
const node={id:'fixture',language:'python',source:'def f():\n    parent.mkdir()\n    temporary.unlink()\n    try:\n        copy()\n        replace()\n    finally:\n        temporary.unlink()',calls:[{name:'parent.mkdir',line:2},{name:'temporary.unlink',line:3},{name:'copy',line:5},{name:'replace',line:6},{name:'temporary.unlink',line:8}],externalContracts:contracts};
test('finally checklist preserves five distinct source effect sites and existing contract assumptions',()=>{
 assert.equal(hypothesis.version,38);const before=structuredClone(node),request=buildRequest(node,[]),ledger=JSON.parse(request.input).localLedger;
 assert.deepEqual(node,before);assert.deepEqual(ledger.externalContracts,contracts);
 assert.deepEqual(ledger.effectChecklist.map(c=>[c.line,c.name,c.contractIndex]),[[2,'parent.mkdir',0],[3,'temporary.unlink',1],[5,'copy',2],[6,'replace',3],[8,'temporary.unlink',1]]);
 for(const entry of ledger.effectChecklist)assert.deepEqual(entry.effects,contracts[entry.contractIndex].effects);
 for(const phrase of ['SOURCE REQUESTS','not automatically external writes','initial versus finally cleanup','never imply all effects run','unused return','conditional assumptions'])assert.ok(request.instructions.includes(phrase));
});
test('non-finally Python and other languages retain no checklist or conditional output instructions',()=>{
 for(const other of [{...node,source:'def f():\n    copy()'},{...node,source:'def f():\n    try:\n        copy()\n    except Exception:\n        return None'},{...node,language:'javascript'}]){const request=buildRequest(other,[]);assert.ok(!Object.hasOwn(JSON.parse(request.input).localLedger,'effectChecklist'));assert.ok(!request.instructions.includes('Python finally effect coverage'));}
});
test('query effects stay verbatim and return-only or unknown names add no invented effects',()=>{
 const other={...node,calls:[{name:'query',line:5},{name:'return_only',line:6},{name:'unknown',line:6}],externalContracts:[{name:'query',effects:['파일 종류 조회 요청'],returns:['bool'],assumption:'조건부'}, {name:'return_only',effects:[],returns:['값']}]};const ledger=JSON.parse(buildRequest(other,[]).input).localLedger;
 assert.deepEqual(ledger.effectChecklist,[{line:5,name:'query',contractIndex:0,effects:['파일 종류 조회 요청']}]);assert.deepEqual(ledger.externalContracts,other.externalContracts);
});
