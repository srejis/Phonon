import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,analyzeFiles,requestNode,dependencyOrder} from '../src/parser.mjs';
const root=path.join(ROOT,'.local','test-fixtures-bindings');
async function fixture(name,source){await fs.mkdir(root,{recursive:true});const file=path.join(root,name);await fs.writeFile(file,source);return {file,graph:await analyzeFiles([file])};}
function node(graph,name){const found=graph.nodes.filter(n=>n.name===name);assert.equal(found.length,1);return found[0];}
function call(graph,owner,name){const found=node(graph,owner).calls.filter(c=>c.name===name);assert.equal(found.length,1);return found[0];}

test('TS const shadow redirects to the actual direct alias, not global same-name function',async()=>{
 const {graph}=await fixture('shadow.ts','function leaf() { return 1; }\nfunction other() { return 2; }\nfunction parent() { const leaf = other; return leaf(); }\n');
 assert.equal(call(graph,'parent','leaf').targetId,node(graph,'other').id);
 assert.notEqual(call(graph,'parent','leaf').targetId,node(graph,'leaf').id);
 assert.ok(node(graph,'parent').bindings.some(b=>b.name==='leaf'&&b.kind==='const'&&b.target==='other'));
});

test('TS direct alias chain resolves a known function with no reassignments',async()=>{
 const {graph}=await fixture('alias.ts','function leaf(x: number) { return x * 2; }\nfunction parent(x: number) { const alias = leaf; const second = alias; return second(x); }\n');
 assert.equal(call(graph,'parent','second').targetId,node(graph,'leaf').id);
});

test('reassigned alias is candidate/unresolved instead of false confirmed edge',async()=>{
 const {graph}=await fixture('alias-reassigned.ts','function leaf(x: number) { return x * 2; }\nfunction parent(x: number, other: any) { let alias = leaf; alias = other; return alias(x); }\n');
 const c=call(graph,'parent','alias');assert.equal(c.targetId,null);assert.notEqual(c.status,'confirmed_same_file');assert.equal(c.shadowed,true);
});

test('let/var/parameters/catch local shadows prevent global confirmation',async()=>{
 const {graph}=await fixture('local-shadows.ts','function leaf() { return 1; }\nfunction withLet() { let leaf = 4; return leaf(); }\nfunction withVar() { var leaf = 4; return leaf(); }\nfunction parameter(leaf: any) { return leaf(); }\nfunction catcher() { try { throw 1; } catch (leaf) { return leaf(); } }\n');
 for(const owner of ['withLet','withVar','parameter','catcher']){const c=call(graph,owner,'leaf');assert.equal(c.targetId,null);assert.equal(c.shadowed,true);}
});

for(const [name,source]of [
 ['for','def caller(callbacks):\n    for print in callbacks:\n        print("x")\n'],
 ['with','def caller(manager):\n    with manager as print:\n        print("x")\n'],
 ['catch','def caller():\n    try:\n        raise Exception()\n    except Exception as print:\n        print("x")\n'],
 ['assignment','def caller(callback):\n    print = callback\n    print("x")\n'],
 ['parameter','def caller(print):\n    print("x")\n'],
 ['import','from other import print\ndef caller():\n    print("x")\n']
])test('Python '+name+' print binding excludes standard builtin effect',async()=>{
 const {graph}=await fixture('print-'+name+'.py',source);const c=call(graph,'caller','print');assert.notEqual(c.status,'standard_builtin_contract');assert.deepEqual(node(graph,'caller').externalContracts,[]);assert.equal(c.targetId,null);
});

test('unshadowed Python print preserves verified builtin contract',async()=>{
 const {graph}=await fixture('builtin.py','def caller(value):\n    print(value)\n');assert.equal(call(graph,'caller','print').status,'standard_builtin_contract');assert.equal(node(graph,'caller').externalContracts.length,1);
});

test('lexical import metadata belongs to nearest binding only',async()=>{
 const {graph}=await fixture('imports.ts','import Default, { child as alias } from "./child";\nimport * as ns from "./child";\nexport { alias as publicAlias };\nexport { child as again } from "./child";\nexport * from "./child";\nfunction caller(x: number) { return alias(x); }\nfunction blocked(alias: any) { return alias(1); }\n');
 const info=graph.files[0];assert.equal(info.imports.length,3);assert.ok(info.imports.some(i=>i.kind==='default'&&i.local==='Default'));
 assert.ok(info.imports.some(i=>i.kind==='namespace'&&i.local==='ns'));
 assert.deepEqual(call(graph,'caller','alias').importBinding.source,'./child');assert.equal(call(graph,'caller','alias').importBinding.imported,'child');
 assert.equal(call(graph,'blocked','alias').importBinding,undefined);assert.equal(call(graph,'blocked','alias').shadowed,true);
 assert.ok(info.exports.some(e=>e.exported==='publicAlias'&&e.local==='alias'));
 assert.ok(info.exports.some(e=>e.exported==='again'&&e.imported==='child'&&e.source==='./child'));
 assert.ok(info.exports.some(e=>e.kind==='star'));
});

test('Python relative from-import and module namespace metadata is exact',async()=>{
 const {graph}=await fixture('imports.py','from .impl import child as alias\nimport pkg.module as ns\ndef caller(x):\n    return alias(x)\ndef other(x):\n    return ns.child(x)\n');
 const info=graph.files[0];assert.equal(info.imports.length,2);
 assert.ok(info.imports.some(i=>i.kind==='python_from'&&i.source==='.impl'&&i.local==='alias'&&i.imported==='child'&&i.level===1));
 assert.ok(info.imports.some(i=>i.kind==='python_import'&&i.source==='pkg.module'&&i.local==='ns'));
 assert.equal(call(graph,'other','ns.child').importBinding.local,'ns');
 assert.ok(info.exports.some(e=>e.exported==='alias'&&e.source==='.impl'&&e.imported==='child'));
});

test('TS class initial state has its own owner and is not copied into method processing',async()=>{
 const {graph}=await fixture('class-state.ts','class Counter {\n static seed = 9;\n value = Counter.seed;\n increment() { this.value += 1; return this.value; }\n}\n');
 const init=node(graph,'Counter.top_level'),method=node(graph,'Counter.increment');
 assert.equal(init.ownership,'class_initialization');assert.match(init.source,/static seed = 9/);assert.match(init.source,/value = Counter.seed/);
 assert.doesNotMatch(method.source,/static seed = 9|value = Counter.seed/);
 assert.equal(method.classContext.initializationNodeId,init.id);assert.deepEqual(method.classContext.fieldNames,['seed','value']);
});

test('Python class assignments are preserved separately from its method',async()=>{
 const {graph}=await fixture('class-state.py','class Counter:\n    seed = 9\n    def increment(self):\n        self.value += 1\n        return self.value\n');
 assert.match(node(graph,'Counter.top_level').source,/seed = 9/);
 assert.equal(node(graph,'Counter.increment').classContext.initializationNodeId,node(graph,'Counter.top_level').id);
});

test('location-only movement keeps semantic request unchanged with binding metadata',async()=>{
 const source='function leaf(x: number) { return x * 2; }\nfunction parent(x: number) { const alias = leaf; return alias(x); }\n';
 const first=await fixture('move.ts',source);await fs.writeFile(first.file,'\n\n\n'+source);const after=await analyzeFiles([first.file]);
 for(const name of ['leaf','parent'])assert.deepEqual(requestNode(node(first.graph,name)),requestNode(node(after,name)));
});

test('type-only export keeps AST-only provenance and cannot authorize runtime linkage',async()=>{
 const {graph}=await fixture('type-export.ts','export type { Thing as PublicThing } from "./child";\n');
 assert.deepEqual(graph.diagnostics,[]);
 const item=graph.files[0].exports.find(e=>e.exported==='PublicThing');
 assert.ok(item);assert.equal(item.typeOnly,true);assert.equal(item.imported,'Thing');assert.equal(item.targetId,null);
});

test('actual class field reads and read-modify-write create state references',async()=>{
 const {graph}=await fixture('state-refs.ts','class Counter {\n static seed = 9;\n value = Counter.seed;\n increment() { this.value += 1; return this.value; }\n readStatic() { return Counter.seed; }\n noop(x: number) { return x * 2; }\n writeOnly() { this.value = 7; }\n}\n');
 const owner=node(graph,'Counter.top_level');
 const refs=node(graph,'Counter.increment').references;assert.ok(refs.some(ref=>ref.field==='value'&&ref.access==='read_write'));assert.ok(refs.some(ref=>ref.field==='value'&&ref.access==='read'));
 assert.ok(refs.every(ref=>ref.targetId===owner.id&&ref.kind==='class_state'&&ref.line===1));
 assert.ok(node(graph,'Counter.readStatic').references.some(ref=>ref.object==='Counter'&&ref.field==='seed'));
 assert.deepEqual(node(graph,'Counter.noop').references,[]);assert.deepEqual(node(graph,'Counter.writeOnly').references,[]);
 assert.deepEqual(requestNode(node(graph,'Counter.increment')).references,refs);const order=dependencyOrder(graph).map(n=>n.id);assert.ok(order.indexOf(owner.id)<order.indexOf(node(graph,'Counter.increment').id));
});

test('Python self/ClassName reads reference known state without pretending initialization is a call',async()=>{
 const {graph}=await fixture('state-refs.py','class Counter:\n    seed = 9\n    def read(self):\n        return self.seed + Counter.seed\n    def write(self):\n        self.seed = 3\n    def unknown(self):\n        return self.missing\n');
 const owner=node(graph,'Counter.top_level'),reader=node(graph,'Counter.read');
 assert.equal(reader.references.length,2);assert.ok(reader.references.every(ref=>ref.targetId===owner.id&&ref.kind==='class_state'&&ref.line===2));assert.deepEqual(reader.calls,[]);
 assert.deepEqual(node(graph,'Counter.write').references,[]);assert.deepEqual(node(graph,'Counter.unknown').references,[]);
});

test('shadowed class receiver and rebound self are not linked to known state owner',async()=>{
 const ts=await fixture('state-shadow.ts','class Counter { static seed=9; read(Counter: any) { return Counter.seed; } }\n');
 assert.deepEqual(node(ts.graph,'Counter.read').references,[]);
 const py=await fixture('state-shadow.py','class Counter:\n    seed = 9\n    def read(self, other):\n        self = other\n        return self.seed\n');
 assert.deepEqual(node(py.graph,'Counter.read').references,[]);
});

test('class state references remain semantically stable when source moves',async()=>{
 const source='class Counter {\n value = 9;\n read() { return this.value; }\n}\n';
 const before=await fixture('state-move.ts',source);await fs.writeFile(before.file,'\n\n'+source);const after=await analyzeFiles([before.file]);
 for(const name of ['Counter.read','Counter.top_level'])assert.deepEqual(requestNode(node(before.graph,name)),requestNode(node(after,name)));
});

test('Python typed parameters bind variable names, not annotation identifiers',async()=>{
 const {graph}=await fixture('typed-bindings.py','from pathlib import Path\nfrom typing import Callable\ndef validate(path: Path, root: Path, callback: Callable[[Path], str], count: int = 1):\n    return Path(str(path))\n');
 const owner=node(graph,'validate');assert.deepEqual(owner.bindings.filter(b=>b.kind==='parameter').map(b=>b.name),['path','root','callback','count']);
 const c=call(graph,'validate','Path');assert.equal(c.shadowed,false);assert.equal(c.status,'unresolved');assert.equal(c.importBinding.source,'pathlib');
});

test('Python constructor-assigned state has provenance in later method field references',async()=>{
 const {graph}=await fixture('ctor-state.py','class VoteGroup:\n    __slots__ = ("s", "votes")\n    def __init__(self, s, word, weight):\n        self.s = float(s)\n        self.votes = {word: weight}\n    def add(self, s, word, weight):\n        if s < self.s:\n            self.s = s\n        self.votes[word] = self.votes.get(word, 0) + weight\n    def winner(self):\n        return max(self.votes.items())\n');
 const ctor=node(graph,'VoteGroup.__init__');assert.deepEqual(ctor.initializedFields,['s','votes']);
 for(const owner of ['VoteGroup.add','VoteGroup.winner'])assert.ok(node(graph,owner).references.some(ref=>ref.targetId===ctor.id&&ref.stateOrigin==='constructor_assignment'));
 assert.deepEqual(ctor.references,[]);assert.ok(!node(graph,'VoteGroup.winner').references.some(ref=>ref.field==='__slots__'));
});

test('external module fields are state dependencies but not falsely confirmed own method calls',async()=>{
 const {graph}=await fixture('ctor-modules.py','import torch.nn as nn\nclass TinyNet:\n    def __init__(self, width):\n        self.fc1 = nn.Linear(width, width)\n        self.act = nn.ReLU()\n        self.fc2 = nn.Linear(width, width)\n    def forward(self, x):\n        return self.fc2(self.act(self.fc1(x)))\n');
 const ctor=node(graph,'TinyNet.__init__'),forward=node(graph,'TinyNet.forward');
 assert.deepEqual(forward.references.map(ref=>ref.field).sort(),['act','fc1','fc2']);assert.ok(forward.references.every(ref=>ref.targetId===ctor.id));
 assert.ok(forward.calls.every(c=>c.targetId===null&&c.status!=='confirmed_same_file'));
 assert.ok(!ctor.references.some(ref=>ref.targetId===ctor.id));
});

test('constructor field overriding a method does not confirm the original method call',async()=>{
 const {graph}=await fixture('ctor-override.py','class Worker:\n    def __init__(self, callback):\n        self.work = callback\n    def work(self):\n        return 1\n    def run(self):\n        return self.work()\n');
 const c=call(graph,'Worker.run','self.work');assert.equal(c.targetId,null);assert.ok(node(graph,'Worker.run').references.some(ref=>ref.targetId===node(graph,'Worker.__init__').id));
});

test('constructor field metadata and dependencies remain stable under blank line movement',async()=>{
 const source='class Worker:\n    def __init__(self, value: int):\n        self.value = value\n    def read(self):\n        return self.value\n';
 const before=await fixture('ctor-move.py',source);await fs.writeFile(before.file,'\n\n'+source);const after=await analyzeFiles([before.file]);
 for(const name of ['Worker.__init__','Worker.read'])assert.deepEqual(requestNode(node(before.graph,name)),requestNode(node(after,name)));
});
