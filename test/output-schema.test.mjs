import test from 'node:test';
import assert from 'node:assert/strict';
import {meaningSchema,groupSchema} from '../src/llm.mjs';
import {validateMeaningLanguage} from '../src/meaning-language.mjs';

// Handwritten contract fixtures: no source copy and no generated-model quality claim.
const single=()=>({id:'fixture',input:['계산에 쓰는 입력값'],process:[],output:[],
 childUses:[],uncertainty:[],evidence:[{line:1,claim:'입력값을 받음'}],
 ownerChecks:[{section:'input',index:0,ownerId:'fixture'}]});
const group=()=>({id:'fixture-group',members:[single(),{...single(),id:'other',
 ownerChecks:[{section:'input',index:0,ownerId:'other'}]}]});

test('minimal valid single and group schema fixtures parse and Korean guards accept them',()=>{
 const parsed=meaningSchema.parse(single());assert.equal(validateMeaningLanguage(parsed),parsed);
 const parsedGroup=groupSchema.parse(group());assert.equal(validateMeaningLanguage(parsedGroup),parsedGroup);
 assert.deepEqual(parsedGroup.members.map(m=>m.id),['fixture','other']);
});

test('ownerChecks uncertainty/evidence sections reject for single and group output',()=>{
 for(const section of ['uncertainty','evidence']){
  const value=single();value.ownerChecks[0].section=section;
  assert.equal(meaningSchema.safeParse(value).success,false);
  assert.equal(groupSchema.safeParse({id:'group',members:[value]}).success,false);
 }
});

test('every valid ownership section is accepted; malformed indices and legacy claim checks reject',()=>{
 for(const section of ['input','process','output','childUses']){
  const value=single();value.ownerChecks[0].section=section;
  assert.equal(meaningSchema.safeParse(value).success,true);
 }
 for(const index of [-1,0.5,'0']){const value=single();value.ownerChecks[0].index=index;
  assert.equal(meaningSchema.safeParse(value).success,false);}
 const legacy=single();legacy.ownerChecks=[{claim:'입력값을 받음',ownerId:'fixture'}];
 assert.equal(meaningSchema.safeParse(legacy).success,false);
});

test('strict schema rejects unexpected fields at every output nesting level',()=>{
 const top=single();top.extra='unexpected';assert.equal(meaningSchema.safeParse(top).success,false);
 const envelope=group();envelope.extra=true;assert.equal(groupSchema.safeParse(envelope).success,false);
 const member=group();member.members[0].extra=true;assert.equal(groupSchema.safeParse(member).success,false);
 const evidence=single();evidence.evidence[0].extra=true;assert.equal(meaningSchema.safeParse(evidence).success,false);
 const use=single();use.childUses=[{childId:'other',description:'결과를 반환값으로 사용',extra:true}];assert.equal(meaningSchema.safeParse(use).success,false);
 const owner=single();owner.ownerChecks[0].extra=true;assert.equal(meaningSchema.safeParse(owner).success,false);
});

test('schema alone permits English prose but the independent language guard rejects it',()=>{
 const value=group();value.members[0].input=['Input for computation'];
 const parsed=groupSchema.parse(value);assert.throws(()=>validateMeaningLanguage(parsed),TypeError);
});

test('required ownerChecks and typed arrays cannot be omitted or replaced with unknown values',()=>{
 const missing=single();delete missing.ownerChecks;assert.equal(meaningSchema.safeParse(missing).success,false);
 const empty=single();empty.input=[];empty.evidence=[];empty.ownerChecks=[];
 assert.equal(validateMeaningLanguage(meaningSchema.parse(empty)).input.length,0);
 for(const malformed of [null,undefined,[],{id:'unknown'}])assert.equal(meaningSchema.safeParse(malformed).success,false);
});
