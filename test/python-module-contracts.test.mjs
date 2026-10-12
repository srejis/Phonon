import test from 'node:test';import assert from 'node:assert/strict';
import {getPythonModuleContract,supportedPythonModuleCalls} from '../src/python-module-contracts.mjs';
const proof={language:'python',lexicalImportVerified:true};
const call=(name,source,local=source,extra={})=>({name,targetId:null,status:'external_boundary',relationReason:'external_boundary',shadowed:false,importBinding:{source,local,imported:'*',kind:'python_import',level:0},...extra});
test('observed direct stdlib calls have sourced minimal contracts only',()=>{
 assert.deepEqual(supportedPythonModuleCalls,['os.path.normcase','os.replace','shutil.copy2','hashlib.sha1']);
 for(const [name,source]of [['os.path.normcase','os'],['os.replace','os'],['shutil.copy2','shutil'],['hashlib.sha1','hashlib']]){
  const result=getPythonModuleContract(call(name,source),proof);assert.equal(result.canonicalName,name);assert.equal(result.name,name);assert.ok(result.source.startsWith('https://docs.python.org/3.14/'));assert.match(result.assumption,/monkey-patching/);
 }
});
test('python_import aliases and unaliased dotted modules preserve real call spelling',()=>{
 const alias=getPythonModuleContract(call('operating.replace','os','operating'),proof);assert.equal(alias.canonicalName,'os.replace');assert.equal(alias.name,'operating.replace');
 assert.equal(getPythonModuleContract(call('osp.normcase','os.path','osp'),proof).canonicalName,'os.path.normcase');
 assert.equal(getPythonModuleContract(call('os.path.normcase','os.path','os'),proof).canonicalName,'os.path.normcase');
 assert.equal(getPythonModuleContract(call('os.normcase','os.path','os'),proof),null);
});
test('python_from function and module aliases resolve only exact supported symbols',()=>{
 const from=(name,source,imported,local)=>call(name,source,local,{importBinding:{source,imported,local,kind:'python_from',level:0}});
 assert.equal(getPythonModuleContract(from('rename','os','replace','rename'),proof).canonicalName,'os.replace');
 assert.equal(getPythonModuleContract(from('p.normcase','os','path','p'),proof).canonicalName,'os.path.normcase');
 assert.equal(getPythonModuleContract(from('digest','hashlib','sha1','digest'),proof).canonicalName,'hashlib.sha1');
 assert.equal(getPythonModuleContract(from('copy','shutil','copy2','copy'),proof).canonicalName,'shutil.copy2');
 assert.equal(getPythonModuleContract(from('replace','os','*','replace'),proof),null);
});
test('unproved imports, local targets, shadows, candidates, reassignment and relative sources reject',()=>{
 const good=call('os.replace','os');
 for(const options of [{},{language:'python'},{language:'python',lexicalImportVerified:false},{language:'javascript',lexicalImportVerified:true}])assert.equal(getPythonModuleContract(good,options),null);
 for(const extra of [{targetId:'local'}, {status:'unresolved'}, {status:'candidate'}, {status:'ambiguous'}, {shadowed:true}, {shadowed:undefined}, {reassigned:true}, {candidates:['local']}, {relationReason:'ambiguous'}, {importBinding:undefined}])assert.equal(getPythonModuleContract({...good,...extra},proof),null);
 for(const extra of [{level:1},{reassigned:true},{status:'candidate'},{source:'.os'},{source:'custom_os'},{kind:'unknown'}])assert.equal(getPythonModuleContract({...good,importBinding:{...good.importBinding,...extra}},proof),null);
});
test('unknown receivers, properties, dynamic chains and extra module operations stay unconfirmed',()=>{
 for(const name of ['path.resolve','obj.copy2','hashlib.sha1(data).hexdigest','digest.hexdigest','os.path','os.remove','shutil.copy','hashlib.sha256'])assert.equal(getPythonModuleContract(call(name,name.split('.')[0]),proof),null);
 assert.equal(getPythonModuleContract(call('hashlib.sha1.extra','hashlib'),proof),null);
});
test('contract return does not mutate call or authorize real filesystem/content claims',()=>{
 const original=call('hashlib.sha1','hashlib'),before=structuredClone(original),result=getPythonModuleContract(original,proof);assert.deepEqual(original,before);assert.match(result.output,/객체.*hexdigest/);
 result.output='changed';assert.notEqual(getPythonModuleContract(original,proof).output,'changed');
 assert.match(getPythonModuleContract(call('os.path.normcase','os'),proof).process,/Windows.*다른 운영체제/);
 assert.match(getPythonModuleContract(call('shutil.copy2','shutil'),proof).process,/모든 메타데이터.*보장하지/);
});
