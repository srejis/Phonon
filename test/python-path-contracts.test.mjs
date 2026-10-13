import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {analyzeFiles,requestNode} from '../src/parser.mjs';import {resolveRelations} from '../src/relations.mjs';import {buildRequest,hypothesis} from '../experiments/h3.mjs';
const root=path.resolve(import.meta.dirname,'..','.local','test-fixtures-declared-path',randomUUID());fs.mkdirSync(root,{recursive:true});
async function parse(label,source,extra={}){const dir=path.join(root,label);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'sample.py'),source);for(const[name,text]of Object.entries(extra))fs.writeFileSync(path.join(dir,name),text);const graph=await analyzeFiles(['sample.py',...Object.keys(extra)].map(n=>path.join(dir,n)));assert.deepEqual(graph.diagnostics,[]);await resolveRelations(graph,{projectRoot:dir});return graph.nodes.find(n=>n.name==='manage');}
const known='from pathlib import Path as P\n\ndef manage(dst: P):\n    dst.parent.mkdir(parents=True, exist_ok=True)\n    temporary = dst.with_suffix(".scratch")\n    temporary.unlink()\n    with temporary.open("rb") as stream:\n        pass\n    if dst.is_file():\n        return dst.resolve()\n    return dst.with_suffix("")\n';
const pathContracts=node=>(node.externalContracts??[]).filter(c=>c.canonicalName?.startsWith('pathlib.'));
test('declared Path alias, parent and unique with_suffix assignment get conditional six-method contracts',async()=>{
 const node=await parse('positive',known),contracts=pathContracts(node);assert.deepEqual([...new Set(contracts.map(c=>c.canonicalName.split('.').at(-1)))].sort(),['is_file','mkdir','open','resolve','unlink','with_suffix']);
 for(const contract of contracts){assert.match(contract.assumption,/타입 주석.*런타임 강제/);assert.ok(Array.isArray(contract.returns));assert.ok(Array.isArray(contract.effects));assert.ok(contract.source.startsWith('https://docs.python.org/'));}
 const cleanup=node.calls.find(c=>c.name==='temporary.unlink');assert.equal(cleanup.resultUse,'ignored');assert.equal(cleanup.declaredPathProvenance.parameter,'dst');assert.ok(cleanup.declaredPathProvenance.derivations.some(d=>d.kind==='unique_with_suffix_assignment'));
 assert.ok(node.calls.find(c=>c.name==='dst.parent.mkdir').declaredPathProvenance.derivations.some(d=>d.kind==='parent'));
});
test('untyped receivers, import shadows, reassignment and unknown derived receivers stay unconfirmed',async()=>{
 const cases=[
 'from pathlib import Path\ndef manage(dst):\n    dst.mkdir()\n',
 'from pathlib import Path\ndef manage(dst: Path, Path):\n    dst.mkdir()\n',
 'from pathlib import Path\ndef manage(dst: Path):\n    dst = replacement\n    dst.unlink()\n',
 'from pathlib import Path\ndef manage(dst: Path):\n    temporary = dst.with_suffix(".tmp")\n    temporary = replacement\n    temporary.unlink()\n',
 'from pathlib import Path\ndef manage(dst: Path):\n    dst.unknown.unlink()\n    dst.suffix.mkdir()\n'
 ];
 for(let i=0;i<cases.length;i++){const node=await parse('negative-'+i,cases[i]);assert.ok(!pathContracts(node).some(c=>c.canonicalName.endsWith('.mkdir')||c.canonicalName.endsWith('.unlink')));}
});
test('local pathlib module cannot be assigned the standard declared Path contract',async()=>{
 const node=await parse('local',known,{'pathlib.py':'class Path:\n    pass\n'});assert.deepEqual(pathContracts(node),[]);
});
test('AST resultUse separates ignored call, local use, direct return and raised constructor',async()=>{
 const node=await parse('use','from pathlib import Path\nimport shutil\ndef manage(dst: Path):\n    shutil.copy2(dst, dst)\n    value = str(dst)\n    if value:\n        raise ValueError(value)\n    return dst.with_suffix(".tmp")\n');
 const find=name=>node.calls.find(c=>c.name===name);assert.equal(find('shutil.copy2').resultUse,'ignored');assert.equal(find('str').resultUse,'local_use');assert.equal(find('ValueError').resultUse,'raised');assert.equal(find('dst.with_suffix').resultUse,'direct_return');
 const copy=node.externalContracts.find(c=>c.name==='shutil.copy2');assert.ok(copy.returns.some(v=>v.includes('경로')));assert.ok(copy.effects.some(v=>v.includes('복사')));
 const ledger=JSON.parse(buildRequest(requestNode(node),[]).input).localLedger;assert.equal(ledger.callSites.find(c=>c.name==='shutil.copy2').resultUse,'ignored');
 assert.match(buildRequest(requestNode(node),[]).instructions,/must\n   NOT become this node's output/);assert.equal(hypothesis.version,35);
});
test('unknown stat and constructor/deep chains are not promoted by method spelling alone',async()=>{
 const node=await parse('unsupported','from pathlib import Path\ndef manage(dst: Path):\n    dst.stat()\n    other.unlink()\n    Path("x").mkdir()\n');assert.deepEqual(pathContracts(node),[]);
});
test('blank-line movement preserves normalized provenance and semantic request',async()=>{
 const node=await parse('movement',known),file=node.file;fs.writeFileSync(file,'\n\n'+known);const graph=await analyzeFiles([file]);await resolveRelations(graph,{projectRoot:path.dirname(file)});const shifted=graph.nodes.find(n=>n.name==='manage');assert.equal(buildRequest(requestNode(node),[]).input,buildRequest(requestNode(shifted),[]).input);
});
test('conditional if/try/loop assignment does not establish definite derived alias provenance',async()=>{
 const bodies=[
 '    if flag:\n        temporary = dst.with_suffix(".tmp")\n    temporary.unlink()\n',
 '    try:\n        temporary = dst.with_suffix(".tmp")\n    except Exception:\n        pass\n    temporary.unlink()\n',
 '    for value in values:\n        temporary = dst.with_suffix(".tmp")\n    temporary.unlink()\n'
 ];
 for(let i=0;i<bodies.length;i++){const node=await parse('conditional-'+i,'from pathlib import Path\ndef manage(dst: Path):\n'+bodies[i]);assert.ok(!pathContracts(node).some(c=>c.name==='temporary.unlink'));}
});
test('deleted, augmented and loop-bound typed parameters cannot receive Path contracts',async()=>{
 const bodies=['    del dst\n    dst.unlink()\n','    dst += replacement\n    dst.unlink()\n','    for dst in values:\n        dst.unlink()\n'];
 for(let i=0;i<bodies.length;i++){const node=await parse('invalidated-'+i,'from pathlib import Path\ndef manage(dst: Path):\n'+bodies[i]);assert.deepEqual(pathContracts(node),[]);}
});
test('observed receiver and imported Path method assignment/deletion invalidate standard contracts in that scope',async()=>{
 const mutations=['    dst.unlink = replacement\n','    Path.unlink = replacement\n','    del dst.unlink\n'];
 for(let i=0;i<mutations.length;i++){const node=await parse('method-mutation-'+i,'from pathlib import Path\ndef manage(dst: Path):\n'+mutations[i]+'    dst.unlink()\n');assert.ok(!pathContracts(node).some(contract=>contract.name==='dst.unlink'));}
 const alias=await parse('derived-method-mutation','from pathlib import Path\ndef manage(dst: Path):\n    temporary = dst.with_suffix(".tmp")\n    temporary.unlink = replacement\n    temporary.unlink()\n');assert.ok(!pathContracts(alias).some(contract=>contract.name==='temporary.unlink'));
});
test('unrelated receiver and uninvoked nested scope mutation do not create global speculative exclusions',async()=>{
 const unrelated=await parse('unrelated-method-mutation','from pathlib import Path\ndef manage(dst: Path):\n    other.unlink = replacement\n    dst.unlink()\n');assert.ok(pathContracts(unrelated).some(contract=>contract.name==='dst.unlink'));
 const nested=await parse('nested-method-mutation','from pathlib import Path\ndef manage(dst: Path):\n    def unused():\n        dst.unlink = replacement\n    dst.unlink()\n');assert.ok(pathContracts(nested).some(contract=>contract.name==='dst.unlink'));
});
