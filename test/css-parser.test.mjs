import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseCSS} from '../src/css-parser.mjs';
import {ROOT,analyzeFiles} from '../src/parser.mjs';
const file=path.join(ROOT,'.local','test-fixtures','css-parser','authored.css');
async function graph(source){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);return analyzeFiles([file]);}

test('comma keyframes retain selectors, animation context, declarations and exact original lines',async()=>{
 const source='@keyframes pulse {\n  0%,\n  100% {\n    opacity: 1;\n\n    transform: scale(1);\n  }\n  50% { opacity: .3; }\n}\n';
 const g=await graph(source);assert.deepEqual(g.diagnostics,[]);assert.equal(g.nodes.length,2);
 const first=g.nodes[0];assert.equal(first.name,'@keyframes pulse / 0%,\n  100%');
 assert.equal(first.startLine,2);assert.equal(first.endLine,7);assert.deepEqual(first.lineMap,[2,3,4,6,7]);
 assert.deepEqual(first.cssContext,[{kind:'at_rule',name:'keyframes',params:'pulse',header:'@keyframes pulse'}]);
 assert.match(first.source,/0%,\n  100%/);assert.match(first.source,/transform: scale\(1\)/);
 assert.equal(first.facts.find(f=>f.text.includes('transform')).line,4);
 assert.equal(source.split('\n')[first.lineMap[3]-1].trim(),'transform: scale(1);');
});
test('ordinary and media IDs remain compatible and duplicate rules remain distinct',async()=>{
 const source='.card {color:red;}\n@media (min-width: 600px) { .card {display:grid;} }\n.card {padding:2px;}';
 const g=await graph(source),key=file.replaceAll('\\','/');assert.deepEqual(g.diagnostics,[]);
 assert.deepEqual(g.nodes.map(n=>n.id),[key+'::.card',key+'::(min-width: 600px) / .card',key+'::.card#2']);
 assert.ok(g.nodes.every(n=>n.kind==='rule_set'));
 assert.equal(g.nodes[1].cssContext[0].name,'media');
});
test('supports/layer/container and nested selector context are retained',()=>{
 const source='@layer design { @supports (display:grid) { @container card (width > 20px) { .card { & button {color:red} } } } }';
 const {nodes}=parseCSS(source,{file});assert.equal(nodes.length,2);
 assert.deepEqual(nodes[1].cssContext.map(c=>c.kind==='rule'?c.selector:c.name),['layer','supports','container','.card']);
 assert.match(nodes[1].source,/& button/);
});
test('at-rule declarations and statements are preserved without inventing regular selectors',()=>{
 const source='@import "other.css";\n@font-face {font-family:Demo;src:url("demo.woff2")}\n@property --tone {syntax:"<color>";inherits:false;initial-value:red;}';
 const {nodes}=parseCSS(source,{file});assert.equal(nodes.length,3);assert.ok(nodes.every(n=>n.kind==='at_rule'));
 assert.equal(nodes[0].source,'@import "other.css";');assert.equal(nodes[1].facts.length,2);assert.equal(nodes[2].facts.length,3);
});
test('CRLF original spans and declaration evidence survive blank lines',()=>{
 const source='\r\n.x {\r\n color:red;\r\n\r\n padding:2px;\r\n}\r\n';
 const node=parseCSS(source,{file}).nodes[0];assert.deepEqual(node.lineMap,[2,3,5,6]);assert.equal(node.facts[1].line,3);assert.equal(node.startLine,2);assert.equal(node.endLine,6);
});
test('empty media/container/keyframe containers retain their source and context',()=>{
 const source='@media screen {}\n@container panel (width > 10px) {}\n@keyframes empty {}\n@supports (display:grid) { @media print {} }';
 const {nodes}=parseCSS(source,{file});assert.equal(nodes.length,4);
 assert.deepEqual(nodes.map(n=>n.source),['@media screen {}','@container panel (width > 10px) {}','@keyframes empty {}','@media print {}']);
 assert.deepEqual(nodes[3].cssContext,[{kind:'at_rule',name:'supports',params:'(display:grid)',header:'@supports (display:grid)'}]);
});
test('raw node bounds include closing braces and semicolons without neighboring syntax',()=>{
 const source='/*한글*/ .first{color:red;} .second{color:blue}\n@import "x.css";\n';
 const {nodes}=parseCSS(source,{file});assert.deepEqual(nodes.map(n=>n.source),['.first{color:red;}','.second{color:blue}','@import "x.css";']);
 assert.deepEqual(nodes.slice(0,2).map(n=>n.facts[0].text),['color:red;','color:blue']);
});
test('unclosed CSS fails explicitly without masking or partial nodes',async()=>{
 const g=await graph('@keyframes pulse { 0%, 100% { opacity:1; }');assert.equal(g.nodes.length,0);assert.equal(g.diagnostics[0].status,'parse_failed');assert.equal(g.diagnostics[0].reason,'PostCSS rejected CSS syntax');
});
