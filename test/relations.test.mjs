import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFiles, ROOT } from '../src/parser.mjs';
import { resolveRelations } from '../src/relations.mjs';

const fixtureRoot=path.join(ROOT,'.local','test-fixtures','relations-regression');
async function fixture(name,sources,selected=Object.keys(sources)) {
  const directory=path.join(fixtureRoot,name);
  for(const [relative,source] of Object.entries(sources)) {
    const file=path.join(directory,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,source,'utf8');
  }
  const graph=await analyzeFiles(selected.map(relative=>path.join(directory,relative)));
  assert.deepEqual(graph.diagnostics.filter(d=>d.status==='parse_failed'),[]);
  await resolveRelations(graph,{projectRoot:directory});
  return {graph,directory};
}
function node(graph,directory,file,name) {
  const values=graph.nodes.filter(n=>path.resolve(n.file)===path.resolve(directory,file)&&n.name===name);
  assert.equal(values.length,1,`expected one ${file}::${name}`);
  return values[0];
}
function call(n,name) {
  const calls=n.calls.filter(c=>c.name===name);
  assert.equal(calls.length,1,`expected one call ${name} in ${n.name}`);
  return calls[0];
}

test('Python from import alias resolves the selected file rather than a same-name global',async()=>{
  const {graph,directory}=await fixture('python-named',{
    'local.py':'def add(a, b):\n    return a + b\n',
    'other.py':'def add(a, b):\n    return a - b\n',
    'main.py':'from local import add as plus\ndef run(x):\n    return plus(x, 2)\n'
  });
  const edge=call(node(graph,directory,'main.py','run'),'plus');
  assert.equal(edge.targetId,node(graph,directory,'local.py','add').id);
  assert.equal(edge.status,'confirmed_import');
});

test('Python import namespace connects an explicit member',async()=>{
  const {graph,directory}=await fixture('python-namespace',{
    'local.py':'def twice(x):\n    return x * 2\n',
    'main.py':'import local as ns\ndef run(x):\n    return ns.twice(x)\n'
  });
  assert.equal(call(node(graph,directory,'main.py','run'),'ns.twice').targetId,node(graph,directory,'local.py','twice').id);
});

test('Python relative package init reexport reaches its implementation',async()=>{
  const {graph,directory}=await fixture('python-reexport',{
    'pkg/__init__.py':'from .impl import add as public_add\n',
    'pkg/impl.py':'def add(a, b):\n    return a + b\n',
    'main.py':'from pkg import public_add\ndef run(x):\n    return public_add(x, 2)\n'
  });
  const edge=call(node(graph,directory,'main.py','run'),'public_add');
  assert.equal(edge.targetId,node(graph,directory,'pkg/impl.py','add').id);
  assert.equal(edge.status,'confirmed_reexport');
});

test('Python same binding parameter shadow blocks imported function',async()=>{
  const {graph,directory}=await fixture('python-shadow',{
    'local.py':'def add(a, b):\n    return a + b\n',
    'main.py':'from local import add\ndef run(add, x):\n    return add(x, 2)\n'
  });
  assert.equal(call(node(graph,directory,'main.py','run'),'add').targetId,null);
});

test('TypeScript named, default and namespace imports resolve unique exports',async()=>{
  const {graph,directory}=await fixture('ts-imports',{
    'lib.ts':'export function add(a: number, b: number) { return a + b; }\nexport default function twice(x: number) { return x * 2; }\n',
    'main.ts':'import twice, {add as plus} from "./lib";\nimport * as ns from "./lib";\nexport function run(x: number) { return twice(plus(x, 2)) + ns.add(x, 1); }\n'
  });
  const parent=node(graph,directory,'main.ts','run');
  assert.equal(call(parent,'twice').targetId,node(graph,directory,'lib.ts','twice').id);
  assert.equal(call(parent,'plus').targetId,node(graph,directory,'lib.ts','add').id);
  assert.equal(call(parent,'ns.add').targetId,node(graph,directory,'lib.ts','add').id);
});

test('JavaScript explicit barrel alias reexport resolves the exported original',async()=>{
  const {graph,directory}=await fixture('js-barrel',{
    'lib.js':'export function add(a, b) { return a + b; }\n',
    'index.js':'export {add as plus} from "./lib.js";\n',
    'main.js':'import {plus} from "./index.js";\nexport function run(x) { return plus(x, 2); }\n'
  });
  const edge=call(node(graph,directory,'main.js','run'),'plus');
  assert.equal(edge.targetId,node(graph,directory,'lib.js','add').id);
  assert.equal(edge.status,'confirmed_reexport');
});

test('conflicting star barrel exports remain ambiguous without arbitrary choice',async()=>{
  const {graph,directory}=await fixture('ts-ambiguous',{
    'a.ts':'export function add(x: number) { return x + 1; }\n',
    'b.ts':'export function add(x: number) { return x * 2; }\n',
    'index.ts':'export * from "./a";\nexport * from "./b";\n',
    'main.ts':'import {add} from "./index";\nexport function run(x: number) { return add(x); }\n'
  });
  const edge=call(node(graph,directory,'main.ts','run'),'add');
  assert.equal(edge.targetId,null);
  assert.equal(edge.status,'ambiguous');
});

test('TypeScript local declarations and parameters shadow imports',async()=>{
  const {graph,directory}=await fixture('ts-shadow',{
    'lib.ts':'export function transform(x: number) { return x + 1; }\n',
    'main.ts':'import {transform} from "./lib";\nexport function parameter(transform: (x: number) => number) { return transform(2); }\nexport function local() { const transform = (x: number) => x * 3; return transform(2); }\n'
  });
  const imported=node(graph,directory,'lib.ts','transform');
  assert.equal(call(node(graph,directory,'main.ts','parameter'),'transform').targetId,null);
  assert.notEqual(call(node(graph,directory,'main.ts','local'),'transform').targetId,imported.id);
});

test('external builtin and bare package imports stay boundary calls',async()=>{
  const python=await fixture('python-boundary',{'main.py':'import math\ndef run(x):\n    return math.sqrt(x)\n'});
  const py=call(node(python.graph,python.directory,'main.py','run'),'math.sqrt');
  assert.equal(py.targetId,null); assert.equal(py.status,'external_boundary');
  const js=await fixture('js-boundary',{'main.js':'import {readFile} from "node:fs/promises";\nexport function run(x) { return readFile(x); }\n'});
  const edge=call(node(js.graph,js.directory,'main.js','run'),'readFile');
  assert.equal(edge.targetId,null); assert.equal(edge.status,'external_boundary');
});

test('a real but unselected local file is not automatically discovered or read',async()=>{
  const {graph,directory}=await fixture('missing-scope',{
    'lib.ts':'export function add(x: number) { return x + 1; }\n',
    'main.ts':'import {add} from "./lib";\nexport function run(x: number) { return add(x); }\n'
  },['main.ts']);
  const edge=call(node(graph,directory,'main.ts','run'),'add');
  assert.equal(edge.targetId,null); assert.equal(edge.relationReason,'unresolved_path');
  assert.equal(graph.files.length,1);
});

test('no import binding cannot resolve through global same-name matching',async()=>{
  const {graph,directory}=await fixture('no-import',{
    'lib.js':'export function add(x) { return x + 1; }\n',
    'main.js':'export function run(x) { return add(x); }\n'
  });
  assert.equal(call(node(graph,directory,'main.js','run'),'add').targetId,null);
});

test('out-of-project relation remains unresolved even if its file was analyzed',async()=>{
  const {graph,directory}=await fixture('scope-boundary',{
    'outside.ts':'export function add(x: number) { return x + 1; }\n',
    'inside/main.ts':'import {add} from "../outside";\nexport function run(x: number) { return add(x); }\n'
  });
  // Reanalyze to test only the restrictive project scope.
  const restricted=await analyzeFiles(graph.files.map(file=>file.file));
  await resolveRelations(restricted,{projectRoot:path.join(directory,'inside')});
  const edge=call(node(restricted,directory,'inside/main.ts','run'),'add');
  assert.equal(edge.targetId,null); assert.equal(edge.relationReason,'outside_project_scope');
});

test('an import followed by a local export specifier forms a verified barrel',async()=>{
  const {graph,directory}=await fixture('js-local-barrel',{
    'lib.js':'export function add(x) { return x + 1; }\n',
    'index.js':'import {add as localAdd} from "./lib.js";\nexport {localAdd as plus};\n',
    'main.js':'import {plus} from "./index.js";\nexport function run(x) { return plus(x); }\n'
  });
  const edge=call(node(graph,directory,'main.js','run'),'plus');
  assert.equal(edge.targetId,node(graph,directory,'lib.js','add').id);
  assert.equal(edge.status,'confirmed_reexport');
});

test('type-only imports do not become runtime call dependencies',async()=>{
  const {graph,directory}=await fixture('ts-type-only',{
    'lib.ts':'export function add(x: number) { return x + 1; }\n',
    'main.ts':'import type {add} from "./lib";\nexport function run(x: number) { return add(x); }\n'
  });
  const edge=call(node(graph,directory,'main.ts','run'),'add');
  assert.equal(edge.targetId,null);
  assert.equal(edge.relationReason,'type_only_not_callable');
});

test('a missing star reexport path prevents claiming a unique export',async()=>{
  const {graph,directory}=await fixture('ts-incomplete-barrel',{
    'lib.ts':'export function add(x: number) { return x + 1; }\n',
    'index.ts':'export * from "./lib";\nexport * from "./not-selected";\n',
    'main.ts':'import {add} from "./index";\nexport function run(x: number) { return add(x); }\n'
  });
  const edge=call(node(graph,directory,'main.ts','run'),'add');
  assert.equal(edge.targetId,null);
  assert.equal(edge.relationReason,'unresolved_path');
});

test('dynamic module loading remains unresolved without explicit import binding',async()=>{
  const {graph,directory}=await fixture('js-dynamic',{
    'lib.js':'export function add(x) { return x + 1; }\n',
    'main.js':'export async function run(x) { const mod = await import("./lib.js"); return mod.add(x); }\n'
  });
  const edge=call(node(graph,directory,'main.js','run'),'mod.add');
  assert.equal(edge.targetId,null);
  assert.notEqual(edge.status,'confirmed_import');
});

test('Python external package is a boundary while an unselected local module stays unresolved',async()=>{
  const external=await fixture('python-external-package',{'main.py':'from phonon_missing_external_package import transform\ndef run(x):\n    return transform(x)\n'});
  const externalCall=call(node(external.graph,external.directory,'main.py','run'),'transform');
  assert.equal(externalCall.targetId,null);assert.equal(externalCall.status,'external_boundary');
  const local=await fixture('python-unselected-local',{
    'local.py':'def transform(x):\n    return x + 1\n',
    'main.py':'from local import transform\ndef run(x):\n    return transform(x)\n'
  },['main.py']);
  const localCall=call(node(local.graph,local.directory,'main.py','run'),'transform');
  assert.equal(localCall.targetId,null);assert.equal(localCall.relationReason,'unresolved_path');
  assert.notEqual(localCall.status,'external_boundary');
});
