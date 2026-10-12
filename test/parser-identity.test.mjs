import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT, analyzeFiles} from '../src/parser.mjs';

const root=path.join(ROOT,'.local','test-fixtures','parser-identity');
async function fixture(name,source){
 await fs.mkdir(root,{recursive:true});
 const file=path.join(root,name);await fs.writeFile(file,source,'utf8');
 return {file,graph:await analyzeFiles([file])};
}
function unique(graph){
 assert.equal(new Set(graph.nodes.map(node=>node.id)).size,graph.nodes.length);
 assert.deepEqual(graph.diagnostics.filter(item=>item.status==='ambiguous_node_identity'),[]);
}

test('same-line sibling callbacks receive separate scope-local identities',async()=>{
 const {graph}=await fixture('siblings.js','function transform(items) { return items.map(x => x + 1).map(y => y * 2); }\n');
 unique(graph);
 const children=graph.nodes.filter(node=>node.scope==='transform'&&node.anonymous);
 assert.deepEqual(children.map(node=>node.name),['transform.anonymous#1','transform.anonymous#2']);
 assert.deepEqual(children.map(node=>node.source),['x => x + 1','y => y * 2']);
});

test('anonymous ordering is independent for different lexical scopes and nested callbacks',async()=>{
 const {graph}=await fixture('scopes.js','function first(xs) { return xs.map(x => xs.map(y => y + x)).filter(z => z); }\nfunction second(xs) { return xs.map(x => x * 2); }\n');
 unique(graph);
 const anonymous=graph.nodes.filter(node=>node.anonymous).map(node=>node.name);
 assert.deepEqual(anonymous,['first.anonymous#1','first.anonymous#1.anonymous#1','first.anonymous#2','second.anonymous#1']);
});

test('moving unchanged definitions down preserves named and anonymous IDs and source',async()=>{
 const source='function transform(items) { return items.map(x => x + 1).map(y => y * 2); }\n';
 const first=await fixture('movement.js',source);
 await fs.writeFile(first.file,'\n\n\n\n'+source,'utf8');
 const moved=await analyzeFiles([first.file]);unique(first.graph);unique(moved);
 assert.equal(moved.nodes.length,first.graph.nodes.length);
 for(let index=0;index<first.graph.nodes.length;index++){
  const old=first.graph.nodes[index],current=moved.nodes[index];
  assert.equal(current.id,old.id);assert.equal(current.name,old.name);assert.equal(current.source,old.source);
  assert.equal(current.startLine,old.startLine+4);assert.equal(current.endLine,old.endLine+4);
  assert.deepEqual(current.lineMap,old.lineMap.map(line=>line+4));
 }
});

test('same-named declarations stay separate and a call preserves ambiguous candidates',async()=>{
 const {graph}=await fixture('duplicates.js','function choose(x) { return x + 1; }\nfunction choose(x) { return x - 1; }\nfunction use(x) { return choose(x); }\n');
 unique(graph);
 const definitions=graph.nodes.filter(node=>node.name==='choose');
 assert.equal(definitions.length,2);assert.notEqual(definitions[0].id,definitions[1].id);
 assert.ok(definitions[1].id.endsWith('::choose#2'));
 assert.notEqual(definitions[0].source,definitions[1].source);
 const call=graph.nodes.find(node=>node.name==='use').calls.find(call=>call.name==='choose');
 assert.equal(call.targetId,null);assert.equal(call.status,'candidate');
});

test('repeated CSS selectors retain all source definitions and distinct IDs',async()=>{
 const {graph}=await fixture('repeat.css','.card { color: red; } .card { background: blue; }\n');
 unique(graph);assert.equal(graph.nodes.length,2);
 assert.deepEqual(graph.nodes.map(node=>node.name),['.card','.card']);
 assert.ok(graph.nodes[1].id.endsWith('::.card#2'));
});
