import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,analyzeFiles,requestNode} from '../src/parser.mjs';
const root=path.join(ROOT,'.local','test-fixtures','object-flow');
async function parse(source){fs.mkdirSync(root,{recursive:true});const file=path.join(root,'case.py');fs.writeFileSync(file,source);const graph=await analyzeFiles([file]);assert.deepEqual(graph.diagnostics,[]);return graph;}
const base='class C:\n def __init__(self):\n  self.value=1\n def run(self):\n  return self.value\n';
const byName=(g,name)=>g.nodes.find(n=>n.name===name);
const call=(g,owner,name)=>byName(g,owner).calls.find(c=>c.name===name);
test('unique direct local construction proves initializer dependency and instance member',async()=>{
 const g=await parse(base+'def use():\n obj=C()\n return obj.run()\n');
 const ctor=call(g,'use','C'),member=call(g,'use','obj.run');
 assert.equal(ctor.targetId,byName(g,'C.__init__').id);assert.equal(ctor.status,'confirmed_local_construction');
 assert.equal(ctor.construction.result,'new_instance');assert.equal(ctor.construction.dependency,'initialization');
 assert.equal(member.targetId,byName(g,'C.run').id);assert.equal(member.status,'confirmed_local_instance');
 assert.equal(requestNode(byName(g,'use')).calls.find(c=>c.name==='C').construction.initializerId,ctor.targetId);
});
test('passing a member call result is not an instance escape',async()=>{
 const g=await parse(base+'def use():\n obj=C()\n results.append(obj.run())\n return results\n');
 assert.equal(call(g,'use','obj.run').targetId,byName(g,'C.run').id);
});
test('Python instance staticmethod resolves; external typed and deep receivers remain unknown',async()=>{
 const g=await parse(base+'class D:\n def __init__(self):\n  pass\n @staticmethod\n def helper(x):\n  return x\n def run(self):\n  return self.helper(2)\ndef use(external: C):\n obj=D()\n obj.helper(3)\n external.run()\n obj.registry.run()\n');
 assert.equal(call(g,'D.run','self.helper').targetId,byName(g,'D.helper').id);
 assert.equal(call(g,'use','obj.helper').targetId,byName(g,'D.helper').id);
 assert.equal(call(g,'use','external.run').targetId,null);assert.equal(call(g,'use','obj.registry.run').targetId,null);
});
for(const [name,source]of [
 ['bases',base.replace('class C:','class C(Base):')],
 ['metaclass',base.replace('class C:','class C(metaclass=Meta):')],
 ['class decorator','@wrap\n'+base],
 ['custom new',base+' def __new__(cls):\n  return other\n'],
 ['dynamic attribute',base+' def __getattr__(self,name):\n  return other\n'],
 ['field override',base.replace('self.value=1','self.run=other')],
 ['decorated initializer',base.replace(' def __init__',' @wrap\n def __init__')],
 ['class rebinding',base+'C=other\n'],
 ['class member replacement',base+'C.run=other\n'],
 ['dynamic setter',base+'setattr(C,"run",other)\n'],
 ['class escape',base+'mutate(C)\n']
 ,['class alias escape',base+'Alias=C\n']
 ,['instance class replacement',base.replace('self.value=1','self.__class__=other')]
 ,['instance dict replacement',base.replace('self.value=1','self.__dict__["run"]=other')]
])test(name+' rejects speculative constructor/member relationships',async()=>{
 const g=await parse(source+'def use():\n obj=C()\n return obj.run()\n');assert.equal(call(g,'use','C').targetId,null);assert.equal(call(g,'use','obj.run').targetId,null);
});
for(const [name,body]of [
 ['reassignment',' obj=C()\n obj=other\n return obj.run()'],
 ['conditional assignment',' if enabled:\n  obj=C()\n return obj.run()'],
 ['member override',' obj=C()\n obj.run=other\n return obj.run()'],
 ['instance escape',' obj=C()\n mutate(receiver=obj)\n return obj.run()'],
 ['call before assignment',' obj.run()\n obj=C()\n return 1'],
 ['constructor factory',' obj=factory()\n return obj.run()'],
 ['parameter shadow',' return obj.run()']
 ,['alias escape',' obj=C()\n alias=obj\n alias.run=other\n return obj.run()']
 ,['delete binding',' obj=C()\n del obj\n return obj.run()']
])test(name+' leaves the receiver unconfirmed',async()=>{
 const g=await parse(base+'def use(obj=None):\n'+body+'\n');assert.equal(call(g,'use','obj.run').targetId,null);
});
test('a custom method decorator is not a confirmed instance method',async()=>{
 const g=await parse(base.replace(' def run',' @wrap\n def run')+'def use():\n obj=C()\n return obj.run()\n');assert.equal(call(g,'use','obj.run').targetId,null);
});
test('different same-method classes resolve only the actual local constructor',async()=>{
 const g=await parse(base+base.replaceAll('C','D')+'def use():\n obj=D()\n return obj.run()\n');assert.equal(call(g,'use','obj.run').targetId,byName(g,'D.run').id);
});
test('duplicate decorated methods cannot turn one filtered candidate into a confirmed target',async()=>{
 const g=await parse(base+' @wrap\n def run(self):\n  return 2\n def caller(self):\n  return self.run()\ndef use():\n obj=C()\n return obj.run()\n');
 assert.equal(call(g,'use','obj.run').targetId,null);assert.equal(call(g,'C.caller','self.run').targetId,null);assert.equal(call(g,'C.caller','self.run').status,'ambiguous');
});
test('moving unchanged constructor flow preserves canonical request and provenance',async()=>{
 const source=base+'def use():\n obj=C()\n return obj.run()\n';const before=await parse(source);const after=await parse('\n\n'+source);
 assert.deepEqual(requestNode(byName(after,'use')),requestNode(byName(before,'use')));
});
