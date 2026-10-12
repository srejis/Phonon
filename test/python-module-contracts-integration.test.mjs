import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {analyzeFiles} from '../src/parser.mjs';import {resolveRelations} from '../src/relations.mjs';
const root=path.resolve(import.meta.dirname,'..','.local','test-fixtures-module-contracts',randomUUID());fs.mkdirSync(root,{recursive:true});
async function fixture(name,files,selected){const dir=path.join(root,name);fs.mkdirSync(dir);for(const [file,source]of Object.entries(files))fs.writeFileSync(path.join(dir,file),source);const graph=await analyzeFiles((selected??Object.keys(files)).map(file=>path.join(dir,file)));assert.deepEqual(graph.diagnostics,[]);await resolveRelations(graph,{projectRoot:dir});return {graph,dir};}
const contracts=graph=>graph.nodes.flatMap(n=>n.externalContracts??[]).filter(c=>c.canonicalName);
const main='import os as operating\nimport shutil as copying\nfrom hashlib import sha1 as digest\nfrom os.path import normcase as norm\nfrom os import path as p\n\ndef action(a, b):\n    operating.replace(a, b)\n    operating.replace(a, b)\n    copying.copy2(a, b)\n    norm(a)\n    p.normcase(a)\n    str(a)\n    print(a)\n    return digest(b).hexdigest()\n';
test('actual parser module aliases yield exact contracts; chains stay unconfirmed and builtin/print persist',async()=>{
 const {graph}=await fixture('aliases',{'main.py':main});const node=graph.nodes.find(n=>n.name==='action');
 assert.deepEqual(contracts(graph).map(c=>c.canonicalName).sort(),['hashlib.sha1','os.path.normcase','os.path.normcase','os.replace','shutil.copy2'].sort());
 assert.equal(node.externalContracts.filter(c=>c.name==='operating.replace').length,1);
 assert.ok(node.externalContracts.some(c=>c.name==='str'));assert.ok(node.externalContracts.some(c=>c.name==='print'));
 const outer=node.calls.find(c=>c.name.endsWith('.hexdigest'));assert.ok(outer);assert.equal(outer.contractStatus,undefined);assert.ok(!node.externalContracts.some(c=>c.name===outer.name));
 for(const call of node.calls.filter(c=>c.contractStatus)){assert.equal(call.targetId,null);assert.equal(call.status,'external_boundary');assert.ok(call.contractSource);}
});
test('local os/shutil modules retain real project targets without stdlib contracts',async()=>{
 const {graph}=await fixture('local-modules',{'main.py':'import os\nimport shutil\n\ndef action(a, b):\n    os.replace(a, b)\n    return shutil.copy2(a, b)\n','os.py':'def replace(a, b):\n    return a\n','shutil.py':'def copy2(a, b):\n    return b\n'});
 assert.deepEqual(contracts(graph),[]);const node=graph.nodes.find(n=>n.name==='action');assert.ok(node.calls.every(c=>c.targetId));
});
test('local core-module collision blocks dotted-source contract even when resolver marks a boundary',async()=>{
 const {graph}=await fixture('dotted-collision',{'main.py':'from os.path import normcase\n\ndef action(a):\n    return normcase(a)\n','os.py':'def unrelated():\n    return 1\n'});
 assert.deepEqual(contracts(graph),[]);
 const unselected=await fixture('unselected-collision',{'main.py':'import os\n\ndef action(a, b):\n    return os.replace(a, b)\n','os.py':'def replace(a, b):\n    return a\n'},['main.py']);assert.deepEqual(contracts(unselected.graph),[]);
});
test('parameter shadows and reassigned imported names cannot receive standard contracts',async()=>{
 const shadow=await fixture('shadow',{'main.py':'import os\n\ndef action(os, a, b):\n    return os.replace(a, b)\n'});assert.deepEqual(contracts(shadow.graph),[]);
 const rebound=await fixture('rebound',{'main.py':'import os as operating\noperating = replacement\n\ndef action(a, b):\n    return operating.replace(a, b)\n'});assert.deepEqual(contracts(rebound.graph),[]);
});
test('external call import metadata must match positive nearest lexical evidence',async()=>{
 const {graph,dir}=await fixture('proof',{'main.py':'import os\n\ndef action(a, b):\n    return os.replace(a, b)\n'});const node=graph.nodes.find(n=>n.name==='action');node.externalContracts=[];node.scopeBindings=node.scopeBindings.filter(b=>b.name!=='os');
 await resolveRelations(graph,{projectRoot:dir});assert.deepEqual(contracts(graph),[]);
});
test('identical name/canonical/source is idempotent while conflicting provenance is preserved',async()=>{
 const {graph,dir}=await fixture('dedup',{'main.py':'import os\n\ndef action(a, b):\n    return os.replace(a, b)\n'});const node=graph.nodes.find(n=>n.name==='action');node.externalContracts.push({name:'os.replace',canonicalName:'custom.replace',source:'different source',input:'다른 입력',process:'다른 처리',output:'다른 출력'});
 await resolveRelations(graph,{projectRoot:dir});assert.equal(node.externalContracts.filter(c=>c.name==='os.replace').length,2);assert.ok(node.externalContracts.some(c=>c.source==='different source'));
});
