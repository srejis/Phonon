import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,analyzeFiles} from '../src/parser.mjs';
const root=path.join(ROOT,'.local','test-fixtures','parser-receiver');
async function parse(name,source){await fs.mkdir(root,{recursive:true});const file=path.join(root,name);await fs.writeFile(file,source);const graph=await analyzeFiles([file]);assert.deepEqual(graph.diagnostics,[]);return graph;}
const node=(g,name)=>g.nodes.find(n=>n.name===name);
const call=(g,name,target)=>node(g,name).calls.find(c=>c.name===target);

test('this direct calls are limited to the same class and matching instance/static methods',async()=>{
 const g=await parse('direct.js','class A { move(){return 1} run(){return this.move()} static stat(){return 2} static go(){return this.stat()} bad(){return this.stat()} }\nclass B { move(){return 3} run(){return this.move()} }');
 assert.equal(call(g,'A.run','this.move').targetId,node(g,'A.move').id);
 assert.equal(call(g,'B.run','this.move').targetId,node(g,'B.move').id);
 assert.equal(call(g,'A.go','this.stat').targetId,node(g,'A.stat').id);
 assert.equal(call(g,'A.bad','this.stat').targetId,null);
});
test('arrow this inherits its method; nested regular function has a different receiver',async()=>{
 const g=await parse('lexical.js','class A { move(){} run(){ const good=()=>this.move(); function bad(){return this.move()} return good(); } }');
 assert.equal(call(g,'A.run.good','this.move').targetId,node(g,'A.move').id);
 assert.equal(call(g,'A.run.bad','this.move').targetId,null);
});
test('field overrides and deeper external receivers are not method calls',async()=>{
 const g=await parse('fields.js','class A { constructor(){this.move=other} move(){} run(){this.move();this.ctx.move()} } class B { move=other; run(){this.move()} } class C { move(){} change(){this.move=other} run(){this.move()} }');
 for(const name of ['A.run','B.run','C.run'])assert.equal(call(g,name,'this.move').targetId,null);
 assert.equal(call(g,'A.run','this.ctx.move').targetId,null);
});
test('ambiguous duplicate methods remain unconfirmed',async()=>{
 const g=await parse('duplicate.js','class A { move(){} move(){} run(){this.move()} }');
 assert.equal(call(g,'A.run','this.move').targetId,null);assert.equal(call(g,'A.run','this.move').status,'ambiguous');
});
test('TypeScript typed methods and lexical arrows preserve direct this ownership',async()=>{
 const g=await parse('typed.ts','class A { move(value:number):number{return value} run(){ const cb=(v:number)=>this.move(v); return cb(2); } }');
 assert.equal(call(g,'A.run.cb','this.move').targetId,node(g,'A.move').id);
});
test('arrow field mutation is an override while a regular function does not inherit this',async()=>{
 const g=await parse('arrow-write.js','class A { move(){} change(){const cb=()=>{this.move=other}} run(){this.move()} } class B { move(){} change(){function f(){this.move=other}} run(){this.move()} }');
 assert.equal(call(g,'A.run','this.move').targetId,null);
 assert.equal(call(g,'B.run','this.move').targetId,node(g,'B.move').id);
});
test('Python staticmethod self parameter is an external receiver',async()=>{
 const g=await parse('static.py','class A:\n @staticmethod\n def move():\n  return 1\n @staticmethod\n def run(self):\n  return self.move()\n');
 assert.equal(call(g,'A.run','self.move').targetId,null);
});
test('Python self closure follows its actual parameter binding and rejects shadowing/rebinding',async()=>{
 const g=await parse('receiver.py','class A:\n def move(self):\n  return 1\n def run(self):\n  def good():\n   return self.move()\n  def bad(self):\n   return self.move()\n  return good()\n def rebound(self):\n  self = other\n  return self.move()\n');
 assert.equal(call(g,'A.run.good','self.move').targetId,node(g,'A.move').id);
 assert.equal(call(g,'A.run.bad','self.move').targetId,null);
 assert.equal(call(g,'A.rebound','self.move').targetId,null);
});
test('callback ownership is direct lexical definition evidence, not invocation',async()=>{
 const g=await parse('callbacks.js','function run(xs){\n const f=x=>x+1;\n return xs.map(x=>xs.map(y=>y+x));\n}\n');
 const parent=node(g,'run');const children=g.nodes.filter(n=>n.scope==='run');
 assert.equal(parent.references.filter(r=>r.kind==='callback_definition').length,2);
 for(const child of children){const ref=parent.references.find(r=>r.targetId===child.id);assert.equal(ref.invocation,false);assert.equal(parent.lineMap[ref.line-1],child.startLine);assert.ok(!parent.calls.some(c=>c.targetId===child.id));}
 const outer=children.find(n=>n.anonymous);const nested=g.nodes.find(n=>n.scope===outer.name);
 assert.equal(outer.references.find(r=>r.targetId===nested.id).kind,'callback_definition');
 assert.ok(!parent.references.some(r=>r.targetId===nested.id));
});
test('observed Python builtin contracts require absence of a lexical binding',async()=>{
 const g=await parse('builtins.py','def good(xs, value):\n print(value)\n return str(value), int(value), isinstance(value, int), next(xs, None), any(xs), max(xs), ValueError("bad")\ndef shadow(str):\n return str(2)\ndef local():\n int = other\n return int(2)\ndef imported():\n from custom import max\n return max([])\ndef ambiguous(value):\n def any(xs):\n  return True\n def any(xs):\n  return False\n return any(value)\n');
 assert.deepEqual(node(g,'good').externalContracts.map(c=>c.name),['print','str','int','isinstance','next','any','max','ValueError']);
 for(const name of ['shadow','local','imported','ambiguous'])assert.deepEqual(node(g,name).externalContracts,[]);
 assert.equal(call(g,'good','ValueError').status,'standard_builtin_contract');
 assert.ok(node(g,'good').externalContracts.find(c=>c.name==='ValueError').process.includes('raise'));
});
