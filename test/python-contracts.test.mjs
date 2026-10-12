import test from 'node:test';import assert from 'node:assert/strict';
import {getPythonBuiltinContract,supportedPythonBuiltins} from '../src/python-contracts.mjs';
const proof={language:'python',lexicalUnshadowed:true};
const call=name=>({name,targetId:null,shadowed:false,bindingScope:null,status:'unresolved',line:1});
test('only seven actual observed symbols have sourced standard contracts',()=>{
 assert.deepEqual(supportedPythonBuiltins.slice().sort(),['ValueError','any','int','isinstance','max','next','str'].sort());
 for(const name of supportedPythonBuiltins){const result=getPythonBuiltinContract(call(name),proof);assert.equal(result.name,name);for(const field of ['input','process','output'])assert.match(result[field],/[가-힣]/);assert.ok(result.source.startsWith('https://docs.python.org/'));assert.match(result.assumption,/monkey-patching/);}
 for(const name of ['Exception','print','len','builtins.str','obj.str','unknown','constructor'])assert.equal(getPythonBuiltinContract(call(name),proof),null);
});
test('positive lexical proof and Python language are mandatory',()=>{
 for(const options of [{},{language:'python'},{language:'python',lexicalUnshadowed:false},{language:'javascript',lexicalUnshadowed:true}])assert.equal(getPythonBuiltinContract(call('str'),options),null);
 assert.equal(getPythonBuiltinContract(null,proof),null);
});
test('local/import/shadow/candidate metadata cannot receive a builtin contract',()=>{
 for(const extra of [{targetId:'local'}, {shadowed:true}, {importBinding:{source:'custom'}}, {bindingScope:'function'}, {candidates:['local']}, {status:'candidate'}, {status:'ambiguous'}, {status:'dynamic'}, {status:'dynamic_import'}])assert.equal(getPythonBuiltinContract({...call('int'),...extra},proof),null);
});
test('iterator consumption, empty/default behavior and exception construction are distinct',()=>{
 assert.match(getPythonBuiltinContract(call('next'),proof).process,/소비/);assert.match(getPythonBuiltinContract(call('next'),proof).output,/StopIteration/);
 assert.match(getPythonBuiltinContract(call('any'),proof).output,/비어.*False/);
 assert.match(getPythonBuiltinContract(call('max'),proof).output,/default.*ValueError/);
 assert.match(getPythonBuiltinContract(call('ValueError'),proof).process,/생성 자체.*raise/);
});
test('call input and registry metadata are not mutated or shared through returned records',()=>{
 const original=Object.freeze(call('str'));const first=getPythonBuiltinContract(original,proof);first.output='changed';
 assert.notEqual(getPythonBuiltinContract(original,proof).output,'changed');assert.equal(original.name,'str');assert.equal(original.status,'unresolved');
});
