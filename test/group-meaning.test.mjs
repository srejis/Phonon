import {decodeGroupRequestData} from '../src/group-request-encoding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGroupRequest, validateGroupMeaning} from '../src/group-meaning.mjs';

const group = {id:'scc-fixture', members:[
 {id:'a',name:'a',language:'python',startLine:1,endLine:4,source:'def a(n):\n if n == 0: return 0\n return b(n-1)',facts:[],calls:[{targetId:'b',line:3},{targetId:'leaf',line:4}]},
 {id:'b',name:'b',language:'python',startLine:1,endLine:3,source:'def b(n):\n if n == 0: return 1\n return a(n-1)',facts:[],calls:[{targetId:'a',line:3}]}
]};
const children = [{id:'leaf',input:['값'],process:['값 보정'],output:['보정한 값'],uncertainty:[],evidence:[]}];
function payload() {
 return {id:group.id,members:group.members.map(member => {
  const childUses=member.calls.map(call=>({childId:call.targetId,description:'확인된 대상의 결과를 반환값 구성에 사용'}));
  const meaning={id:member.id,input:['종료 조건과 호출 준비에 쓰는 n'],process:['n == 0 조건 확인'],output:['직접 반환값 또는 호출 결과'],childUses,uncertainty:[],evidence:[{line:2,claim:'종료 조건과 직접 반환'}]};
  meaning.ownerChecks=['input','process','output','childUses'].flatMap(section=>meaning[section].map((_,index)=>({section,index,ownerId:section==='childUses'?meaning.childUses[index].childId:member.id})));
  return meaning;
 })};
}

test('request preserves all direct code and internal calls without fabricated completed internal meanings',()=>{
 const request=buildGroupRequest(group,children), data=decodeGroupRequestData(JSON.parse(request.input));
 assert.equal(request.input,JSON.stringify(JSON.parse(request.input)));
 assert.equal(data.groupId,group.id);
 assert.equal(data.memberLedgers.length,2);
 assert.equal(data.memberLedgers[0].source,group.members[0].source);
 assert.deepEqual(data.memberLedgers[0].requiredChildIds,['b','leaf']);
 assert.deepEqual(data.memberLedgers[0].internalCalls,[{targetId:'b',line:3}]);
 assert.deepEqual(data.externalOwnershipLedger,children.map(({id,input,process,output,uncertainty})=>({id,input,process,output,uncertainty})));
 assert.match(data.internalMeaningStatus,/not_precomputed/);
 assert.match(request.instructions,/zero-based index/);
 assert.match(request.instructions,/Never assume recursion terminates/);
 assert.match(request.instructions,/normalized source range/);
});

test('valid response covers every member and internal/external dependency with owner references',()=>{
 const value=payload();value.members.reverse();
 assert.deepEqual(validateGroupMeaning(value,group,children).map(m=>m.id),['a','b']);
 const optional=payload();delete optional.members[0].ownerChecks;
 assert.equal(validateGroupMeaning(optional,group,children).length,2);
});

test('reject missing, duplicate, invented member ids and wrong group id',()=>{
 for(const mutate of [p=>p.members.pop(),p=>p.members[1]=p.members[0],p=>p.members[0].id='unknown',p=>p.id='wrong']){
  const value=payload();mutate(value);assert.throws(()=>validateGroupMeaning(value,group,children));
 }
});

test('reject omitted internal/external uses, invented targets and duplicate child uses',()=>{
 for(const mutate of [p=>p.members[0].childUses.pop(),p=>p.members[0].childUses.shift(),
  p=>p.members[0].childUses[0].childId='unknown',p=>p.members[0].childUses.push(p.members[0].childUses[0])]){
  const value=payload();mutate(value);assert.throws(()=>validateGroupMeaning(value,group,children));
 }
});

test('evidence must stay within the current member normalized range',()=>{
 for(const line of [0,4,1.5]){const value=payload();value.members[1].evidence[0].line=line;
  assert.throws(()=>validateGroupMeaning(value,group,children),/evidence/);}
});

test('reject invalid, duplicate, omitted and wrongly owned ownership references',()=>{
 for(const mutate of [p=>p.members[0].ownerChecks[0].index=99,p=>p.members[0].ownerChecks[0].ownerId='b',
  p=>p.members[0].ownerChecks.push(p.members[0].ownerChecks[0]),p=>p.members[0].ownerChecks.pop(),
  p=>p.members[0].ownerChecks[3].ownerId='a']){
  const value=payload();mutate(value);assert.throws(()=>validateGroupMeaning(value,group,children),/owner/);
 }
});

test('external meanings must exist; internal meanings cannot be supplied as precompleted children',()=>{
 assert.throws(()=>buildGroupRequest(group,[]),/completed meaning/);
 assert.throws(()=>buildGroupRequest(group,[...children,{...children[0],id:'a'}]),/internal member/);
 const self={id:'self-group',members:[{id:'self',startLine:1,endLine:2,source:'def self(n): return self(n)',calls:[{targetId:'self',line:1}]}]};
 const value={id:'self-group',members:[{id:'self',input:[],process:[],output:[],childUses:[{childId:'self',description:'자기 호출 결과 사용'}],uncertainty:['종료 여부 미확인'],evidence:[]}]};
 assert.equal(validateGroupMeaning(value,self,[]).length,1);
 assert.deepEqual(decodeGroupRequestData(JSON.parse(buildGroupRequest(self,[]).input)).memberLedgers[0].requiredChildIds,['self']);
});

test('confirmed state reference requires a child use and preserves kind/field/evidence without invocation',()=>{
 const reference={targetId:'leaf',kind:'class_state',line:2,field:'stored',object:'self',access:'read'};
 const refGroup={id:'state-group',members:[{id:'reader',startLine:1,endLine:2,source:'def reader(self): return self.stored',calls:[],references:[reference]}]};
 const request=buildGroupRequest(refGroup,children), data=decodeGroupRequestData(JSON.parse(request.input));
 assert.deepEqual(data.memberLedgers[0].requiredChildIds,['leaf']);
 assert.deepEqual(data.memberLedgers[0].references,[reference]);
 assert.deepEqual(data.memberLedgers[0].internalCalls,[]);
 assert.match(request.instructions,/not function calls/);assert.match(request.instructions,/initializer executes again/);
 const meaning={id:'reader',input:[],process:[],output:['stored 값 반환'],childUses:[{childId:'leaf',description:'보관된 상태를 반환값으로 사용'}],uncertainty:[],evidence:[{line:2,claim:'stored 읽기'}]};
 assert.equal(validateGroupMeaning({id:refGroup.id,members:[meaning]},refGroup,children).length,1);
 assert.throws(()=>validateGroupMeaning({id:refGroup.id,members:[{...meaning,childUses:[]}]},refGroup,children),/coverage/);
 const both={...refGroup,members:[{...refGroup.members[0],calls:[{targetId:'leaf',line:2}]}]};
 assert.deepEqual(decodeGroupRequestData(JSON.parse(buildGroupRequest(both,children).input)).memberLedgers[0].requiredChildIds,['leaf']);
 const internal={id:'reference-cycle',members:[{...refGroup.members[0],references:[{...reference,targetId:'reader'}]}]};
 assert.deepEqual(decodeGroupRequestData(JSON.parse(buildGroupRequest(internal,[]).input)).memberLedgers[0].internalReferences,[{...reference,targetId:'reader'}]);
});

test('self-call group outputs one requested member while completed external child stays a contract only',()=>{
 const self={id:'one-member',members:[{id:'visit',language:'python',startLine:1,endLine:3,source:'def visit(n):\n if n: return visit(n-1)\n return leaf(n)',facts:[],calls:[{targetId:'visit',line:2},{targetId:'leaf',line:3}]}]},request=buildGroupRequest(self,children),data=decodeGroupRequestData(JSON.parse(request.input));
 assert.deepEqual(data.outputMemberIds,['visit']);assert.equal(data.outputMemberCount,1);assert.deepEqual(data.externalOwnershipLedger.map(c=>c.id),['leaf']);assert.deepEqual(data.memberLedgers[0].requiredChildIds,['leaf','visit']);assert.match(request.instructions,/NEVER requested output members/);assert.match(request.instructions,/Self calls still generate just the requested member/);
 const member={id:'visit',input:['재귀 조건에 쓰는 값'],process:['현재 조건 검사'],output:['현재 호출 또는 하위 결과 반환'],childUses:[{childId:'visit',description:'자기 호출 결과 사용'},{childId:'leaf',description:'하위 결과 사용'}],uncertainty:[],evidence:[]};assert.equal(validateGroupMeaning({id:self.id,members:[member]},self,children).length,1);assert.throws(()=>validateGroupMeaning({id:self.id,members:[member,{...member,id:'leaf'}]},self,children),/member count mismatch/);
});
