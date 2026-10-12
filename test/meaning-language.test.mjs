import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMeaningLanguage} from '../src/meaning-language.mjs';
const empty = () => ({id:'node',input:[],process:[],output:[],uncertainty:[],childUses:[],evidence:[]});
function full() {
 return {...empty(),input:['n을 종료 조건의 입력값으로 사용'],process:['n == 0 조건을 확인'],
  output:['False 또는 other(n - 1) 결과를 반환'],uncertainty:['n의 허용 범위는 확인되지 않음'],
  childUses:[{childId:'other',description:'상호 판정 단계의 결과를 반환값으로 사용'}],
  evidence:[{line:2,claim:'직접 조건 검사'}],ownerChecks:[{section:'input',index:0,ownerId:'node'}]};
}

test('accepts Korean prose mixed with identifiers and preserves original object without mutation',()=>{
 const value=full();const before=structuredClone(value);
 Object.freeze(value);for(const name of ['input','process','output','uncertainty','childUses','evidence'])Object.freeze(value[name]);
 assert.equal(validateMeaningLanguage(value),value);assert.deepEqual(value,before);
});

test('zero-length category arrays are valid and missing categories are invalid',()=>{
 assert.equal(validateMeaningLanguage(empty()).id,'node');
 const value=empty();delete value.output;assert.throws(()=>validateMeaningLanguage(value),TypeError);
});

test('English-only prose is rejected in every required text location',()=>{
 for(const section of ['input','process','output','uncertainty']){
  const value=empty();value[section]=['Returns the result'];assert.throws(()=>validateMeaningLanguage(value),TypeError);
 }
 for(const section of ['evidence','childUses']){
  const value=empty();value[section]=section==='evidence'?[{line:1,claim:'Checks condition'}]:[{childId:'other',description:'Returns result'}];
  assert.throws(()=>validateMeaningLanguage(value),TypeError);
 }
});

test('nested group member meanings are checked recursively without rewriting the envelope',()=>{
 const value={id:'group',members:[full(),{id:'nested',members:[empty()]}]};
 const before=structuredClone(value);assert.equal(validateMeaningLanguage(value),value);assert.deepEqual(value,before);
 value.members[1].members[0].process=['Calls another member'];assert.throws(()=>validateMeaningLanguage(value),TypeError);
});

test('malformed/unknown values, empty strings, jamo-only text and cyclic objects are rejected',()=>{
 for(const value of [null,undefined,1,'한글',[],{}, {members:null}, {members:[null]}])assert.throws(()=>validateMeaningLanguage(value),TypeError);
 for(const text of ['', '   ', 3, null, {}, 'ㄱㄴㄷ']){const value=empty();value.input=[text];assert.throws(()=>validateMeaningLanguage(value),TypeError);}
 const value={members:[]};value.members.push(value);assert.throws(()=>validateMeaningLanguage(value),TypeError);
});

test('one Hangul syllable is only a locale guard, not proof of meaning correctness',()=>{
 const value=empty();value.output=['Returns impossible result 가'];
 assert.equal(validateMeaningLanguage(value),value);
});
