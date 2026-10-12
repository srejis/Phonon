import test from 'node:test';import assert from 'node:assert/strict';
import {getPythonBuiltinContract,supportedPythonBuiltins} from '../src/python-contracts.mjs';
const proof={language:'python',lexicalUnshadowed:true};
const call=name=>({name,targetId:null,shadowed:false,bindingScope:null,status:'unresolved',line:1});
test('only eight actual observed symbols have sourced standard contracts',()=>{
 assert.deepEqual(supportedPythonBuiltins.slice().sort(),['ValueError','any','int','isinstance','max','min','next','str'].sort());
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

test('observed min contract selects original item by key, preserves first tie and iterable default boundary',()=>{
 const result=getPythonBuiltinContract(call('min'),proof);assert.match(result.process,/가장 작은/);assert.match(result.process,/key 함수/);assert.match(result.process,/동률.*먼저/);assert.match(result.output,/원래 항목/);assert.match(result.output,/단일 iterable.*default.*ValueError/);assert.match(result.output,/key=None/);assert.equal(result.source,'https://docs.python.org/3.14/library/functions.html#min');
 for(const extra of [{targetId:'local'},{shadowed:true},{bindingScope:'function'},{status:'candidate'},{importBinding:{source:'custom'}}])assert.equal(getPythonBuiltinContract({...call('min'),...extra},proof),null);
});

test('native parser attaches min only to unshadowed lexical call with original lambda key source',async()=>{
 const fs=await import('node:fs'),path=await import('node:path'),{analyzeFiles}=await import('../src/parser.mjs');const dir=path.resolve('.local/test-fixture-python-min-contracts');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'own-min-fixture.py');fs.writeFileSync(file,'def choose(items):\n    return min(items, key=lambda item: item.start_byte)\n\ndef shadow(min, items):\n    return min(items)\n\ndef reassigned(items):\n    min = replacement\n    return min(items)\n\ndef imported(items):\n    from custom import min\n    return min(items)\n');const graph=await analyzeFiles([file]);assert.deepEqual(graph.diagnostics,[]);const choose=graph.nodes.find(n=>n.name==='choose');assert.equal(choose.calls.find(c=>c.name==='min').status,'standard_builtin_contract');assert.match(choose.calls.find(c=>c.name==='min').arguments,/key=lambda item: item.start_byte/);assert.equal(choose.externalContracts.find(c=>c.name==='min').source,'https://docs.python.org/3.14/library/functions.html#min');for(const name of ['shadow','reassigned','imported'])assert.ok(!graph.nodes.find(n=>n.name===name).externalContracts.some(c=>c.name==='min'));
});
