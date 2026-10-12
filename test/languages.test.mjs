import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {analyzeFiles,ROOT} from '../src/parser.mjs';

const fixtureRoot=path.join(ROOT,'.local','test-fixtures-language');
fs.mkdirSync(fixtureRoot,{recursive:true});
function fixture(name,source){
 const file=path.join(fixtureRoot,name);
 fs.writeFileSync(file,source,'utf8');
 return file;
}
function named(graph,name){return graph.nodes.find(node=>node.name===name);}

for(const [extension,language] of [['ts','typescript'],['js','javascript'],['tsx','tsx'],['jsx','tsx']]){
 test(`${extension}: named function, arrow, direct arithmetic and same-file call`,async()=>{
  const typed=extension==='ts'||extension==='tsx';
  const source=`function leaf(x${typed?': number':''}) { return x * 2; }\nconst parent = (x${typed?': number':''}) => { if (x > 0) return leaf(x) + 1; return 0; };\n${extension.endsWith('x')?'const View = () => <div>hello</div>;':''}\n`;
  const graph=await analyzeFiles([fixture(`basic.${extension}`,source)]);
  assert.deepEqual(graph.diagnostics,[]);
  const leaf=named(graph,'leaf'),parent=named(graph,'parent');
  assert.ok(leaf,'named function must be extracted');
  assert.ok(parent,'named arrow must be extracted');
  assert.equal(leaf.language,language);
  assert.match(leaf.source,/x \* 2/);
  assert.ok(leaf.facts.some(f=>f.kind==='return_statement'));
  assert.ok(parent.facts.some(f=>f.kind==='if_statement'&&f.text.includes('x > 0')));
  assert.ok(parent.calls.some(call=>call.name==='leaf'&&call.targetId===leaf.id&&call.status==='confirmed_same_file'));
  if(extension.endsWith('x'))assert.match(named(graph,'View')?.source??'',/<div>hello<\/div>/);
 });
}

test('Python: function, class method, self call and direct processing',async()=>{
 const source='def twice(x):\n    return x * 2\n\nclass Calculator:\n    def leaf(self, x):\n        return twice(x)\n\n    def parent(self, x):\n        if x > 0:\n            return self.leaf(x) + 1\n        return 0\n';
 const graph=await analyzeFiles([fixture('basic.py',source)]);
 assert.deepEqual(graph.diagnostics,[]);
 const twice=named(graph,'twice'),leaf=named(graph,'Calculator.leaf'),parent=named(graph,'Calculator.parent');
 assert.ok(twice);assert.ok(leaf);assert.ok(parent);
 assert.ok(twice.facts.some(f=>f.kind==='binary_operator'&&f.text==='x * 2'));
 assert.ok(leaf.calls.some(call=>call.targetId===twice.id));
 assert.ok(parent.calls.some(call=>call.name==='self.leaf'&&call.targetId===leaf.id));
 assert.ok(parent.facts.some(f=>f.kind==='if_statement'));
});

test('HTML: root structural node retains nested elements and attributes',async()=>{
 const graph=await analyzeFiles([fixture('basic.html','<!doctype html>\n<html><body><main id="root"><button disabled>Go</button></main></body></html>\n')]);
 assert.deepEqual(graph.diagnostics,[]);
 assert.equal(graph.nodes.length,1);
 assert.equal(graph.nodes[0].kind,'element');
 assert.equal(graph.nodes[0].language,'html');
 assert.match(graph.nodes[0].source,/<main id="root">/);
 assert.match(graph.nodes[0].source,/<button disabled>Go<\/button>/);
});

test('CSS: independent selectors retain declarations and nested media rules',async()=>{
 const graph=await analyzeFiles([fixture('basic.css','.card { color: red; padding: 4px; }\n@media (min-width: 600px) { .card { display: grid; } }\n#button { opacity: .5; }\n')]);
 assert.deepEqual(graph.diagnostics,[]);
 assert.equal(graph.nodes.length,3);
 assert.ok(graph.nodes.every(node=>node.kind==='rule_set'&&node.language==='css'));
 assert.ok(graph.nodes.some(node=>node.source.includes('padding: 4px')));
 assert.ok(graph.nodes.some(node=>node.source.includes('display: grid')));
 assert.ok(graph.nodes.some(node=>node.name==='#button'));
});

test('SQL PostgreSQL: parsed file unit contains real CREATE/SELECT AST',async()=>{
 const graph=await analyzeFiles([fixture('basic.sql','CREATE TABLE widget (id INTEGER PRIMARY KEY, title TEXT);\nSELECT title FROM widget WHERE id > 2;\n')]);
 assert.deepEqual(graph.diagnostics,[]);
 assert.equal(graph.nodes.length,1);
 const node=graph.nodes[0];
 assert.equal(node.kind,'sql_file');
 assert.equal(node.language,'sql');
 const statements=JSON.parse(node.facts.find(f=>f.kind==='sql_statements').text);
 assert.deepEqual(statements.map(statement=>statement.type),['create','select']);
 assert.match(node.source,/WHERE id > 2/);
});

for(const [extension,source] of [['ts','function broken( {'],['py','def broken(:\n    return 1'],['sql','SELECT FROM ;']]){
 test(`${extension}: syntax failure yields diagnostic and no valid analysis node`,async()=>{
  const graph=await analyzeFiles([fixture(`invalid.${extension}`,source)]);
  assert.equal(graph.nodes.length,0,'invalid source must not yield a normal analysis node');
  assert.ok(graph.diagnostics.some(item=>item.status==='parse_failed'));
 });
}

test('cross-file import remains unresolved and documented',async()=>{
 const child=fixture('cross-child.ts','export function child(x: number) { return x + 1; }\n');
 const parent=fixture('cross-parent.ts','import { child } from "./cross-child";\nexport function parent(x: number) { return child(x); }\n');
 const graph=await analyzeFiles([child,parent]);
 assert.deepEqual(graph.diagnostics,[]);
 const call=named(graph,'parent').calls.find(item=>item.name==='child');
 assert.ok(call);assert.equal(call.targetId,null);assert.equal(call.status,'unresolved');
 assert.ok(graph.limits.some(limit=>limit.includes('same file')));
 assert.ok(graph.limits.some(limit=>limit.includes('Cross-language')));
});

test('exported top-level variable initialization must be represented',async()=>{
 const source='export const baseline = 2 * 3;\nexport const current = baseline + 1;\n';
 const graph=await analyzeFiles([fixture('exported-state.ts',source)]);
 assert.deepEqual(graph.diagnostics,[]);
 assert.ok(graph.nodes.some(node=>node.source.includes('baseline = 2 * 3')&&node.source.includes('current = baseline + 1')),'exported runtime initializers are code and must not disappear from analysis');
});

test('HTML fragments: every independent root element must be represented',async()=>{
 const graph=await analyzeFiles([fixture('fragments.html','<header>Title</header>\n<main>Content</main>\n')]);
 assert.deepEqual(graph.diagnostics,[]);
 assert.equal(graph.nodes.length,2,'both independent roots must remain inspectable');
 assert.ok(graph.nodes.some(node=>node.source.includes('<main>Content</main>')));
});
