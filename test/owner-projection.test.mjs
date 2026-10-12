import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';
import {meaningSchema,groupSchema,meaningOutputSchema,groupOutputSchema,deriveMeaningOwnership,meaningProfile} from '../src/llm.mjs';
import {validateGroupMeaning} from '../src/group-meaning.mjs';import {buildRequest} from '../experiments/h3.mjs';
const wire=id=>({id,input:['검사에 사용할 입력'],process:['조건 x > 1을 검사'],output:['직접 결과 반환'],childUses:[],uncertainty:[],evidence:[{line:1,claim:'직접 입력 사용'}]});
const strip=value=>{const {ownerChecks,...rest}=value;return rest;};
test('SDK wire excludes ownerChecks while canonical stored schema still requires strict owner references',()=>{
 const value=wire('a');assert.equal(meaningOutputSchema.safeParse(value).success,true);assert.equal(meaningSchema.safeParse(value).success,false);
 const canonical=deriveMeaningOwnership(value);assert.equal(meaningSchema.safeParse(canonical).success,true);
 assert.equal(meaningOutputSchema.safeParse(canonical).success,false);
 const invalid={...canonical,ownerChecks:[{section:'uncertainty',index:0,ownerId:'a'}]};assert.equal(meaningSchema.safeParse(invalid).success,false);
 assert.throws(()=>deriveMeaningOwnership(invalid)); // Never repair old invalid canonical/cache records through the wire path.
});
test('host derives every local section index and child owner exactly without inventing index 12 for 12 process items',()=>{
 const value={...wire('a'),process:Array.from({length:12},(_,i)=>`직접 처리 ${i}`),childUses:[{childId:'child',description:'하위 결과를 사용'}]};
 const canonical=deriveMeaningOwnership(value);
 assert.deepEqual(canonical.ownerChecks.filter(c=>c.section==='process').map(c=>c.index),Array.from({length:12},(_,i)=>i));
 assert.deepEqual(canonical.ownerChecks.find(c=>c.section==='childUses'),{section:'childUses',index:0,ownerId:'child'});
 assert.ok(canonical.ownerChecks.filter(c=>c.section!=='childUses').every(c=>c.ownerId==='a'));
 assert.ok(!canonical.ownerChecks.some(c=>['uncertainty','evidence'].includes(c.section)));
 assert.deepEqual(strip(canonical),value);
});
test('group projection is member-local and canonical group ID/child/evidence range validation is preserved',()=>{
 const payload={id:'g',members:[{...wire('a'),childUses:[{childId:'b',description:'상호 판정 결과 사용'}]}, {...wire('b'),childUses:[{childId:'a',description:'상호 판정 결과 사용'}]}]};
 assert.equal(groupOutputSchema.safeParse(payload).success,true);assert.equal(groupSchema.safeParse(payload).success,false);
 const canonical=deriveMeaningOwnership(payload,'dependency_group'),group={id:'g',members:[{id:'a',startLine:1,endLine:2,calls:[{targetId:'b'}]},{id:'b',startLine:1,endLine:2,calls:[{targetId:'a'}]}]};
 assert.equal(validateGroupMeaning(canonical,group,[]).length,2);
 for(const member of canonical.members){assert.ok(member.ownerChecks.filter(c=>c.section!=='childUses').every(c=>c.ownerId===member.id));assert.equal(member.ownerChecks.find(c=>c.section==='childUses').ownerId,member.childUses[0].childId);}
 const outOfRange=structuredClone(canonical);outOfRange.members[0].evidence[0].line=3;assert.throws(()=>validateGroupMeaning(outOfRange,group,[]),/evidence/);
 const wrongOwner=structuredClone(canonical);wrongOwner.members[0].ownerChecks[0].ownerId='b';assert.throws(()=>validateGroupMeaning(wrongOwner,group,[]),/owner/);
});
test('wire projection preserves exact semantic strings and does not mutate original data',()=>{
 const value={...wire('a'),process:['원문 식 x > 1 && name === "a\\b" 를 사용'],uncertainty:['사용자 정의 연산의 결과는 미확인']};const before=structuredClone(value);Object.freeze(value);Object.freeze(value.process);
 const canonical=deriveMeaningOwnership(value);assert.deepEqual(value,before);assert.deepEqual(strip(canonical),before);assert.equal(canonical.process[0],before.process[0]);
 const node={id:'source',source:'if x > 1:\n    return "a\\b"',startLine:1,endLine:2,calls:[],facts:[]};const request=buildRequest(node,[]);assert.equal(JSON.parse(request.input).localLedger.source.map(row=>row.text).join('\n'),node.source);
 assert.match(request.instructions,/Do NOT emit ownerChecks/);assert.match(request.instructions,/internally check/);
});
test('generation profile uses actual wire schema and differs from the old model-produced trace schema',()=>{
 for(const kind of ['function','dependency_group']){
  const profile=meaningProfile(kind,2000),oldSchema=z.toJSONSchema(kind==='dependency_group'?groupSchema:meaningSchema);
  assert.equal(profile.ownershipTraceOrigin,'host_projection');assert.ok(!JSON.stringify(profile.jsonSchema).includes('ownerChecks'));
  assert.notDeepEqual(profile.jsonSchema,oldSchema);assert.equal(profile.maxTokens,2000);assert.equal(profile.maxTurns,1);
 }
});
test('empty categories produce an empty host trace, and unexpected model fields remain rejected',()=>{
 const value={id:'a',input:[],process:[],output:[],childUses:[],uncertainty:[],evidence:[]};assert.deepEqual(deriveMeaningOwnership(value).ownerChecks,[]);
 assert.throws(()=>deriveMeaningOwnership({...value,extra:true}));assert.throws(()=>deriveMeaningOwnership({id:'g',members:[{...value,ownerChecks:[]}]},'dependency_group'));
});

