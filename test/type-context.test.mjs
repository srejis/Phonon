import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {ROOT,analyzeFiles,requestNode} from '../src/parser.mjs';
const dir=path.join(ROOT,'.local','test-fixtures','type-context');fs.mkdirSync(dir,{recursive:true});
async function parse(name,source){const file=path.join(dir,name+'.tsx');fs.writeFileSync(file,source);return analyzeFiles([file]);}
test('TSX follows actual union/intersection alias fields without runtime edges',async()=>{
 const g=await parse('contracts','type Variant = "main" | "quiet";\ntype Common = { children: ReactNode; variant?: Variant; };\ntype LinkProps = Common & { href: string; };\ntype NativeProps = Common & { href?: never; };\nexport function Button(props: LinkProps | NativeProps) { return <span>{props.children}</span>; }');
 const n=g.nodes.find(n=>n.name==='Button');assert.deepEqual(g.diagnostics,[]);assert.deepEqual(new Set(n.typeContext.declarations.map(d=>d.name)),new Set(['LinkProps','NativeProps','Common','Variant']));assert.deepEqual(n.typeContext.unresolvedTypeNames,['ReactNode']);assert.equal(n.calls.length,0);assert.match(n.typeContext.declarations.find(d=>d.name==='NativeProps').source,/href\?: never/);
});
test('type aliases follow closest lexical scope and exclude nested function contracts',async()=>{
 const g=await parse('scope','type Props = { outer: string };\nfunction Outer(p: Props){ type Local = { local: number }; const value = p as Local; function Inner(q: Different){ return q; } return value; }');
 const outer=g.nodes.find(n=>n.name==='Outer');assert.deepEqual(new Set(outer.typeContext.declarations.map(d=>d.name)),new Set(['Props','Local']));assert.ok(!outer.typeContext.unresolvedTypeNames.includes('Different'));assert.deepEqual(g.nodes.find(n=>n.name==='Outer.Inner').typeContext.unresolvedTypeNames,['Different']);
});
test('type context is stable under blank line movement and recursive aliases terminate',async()=>{
 const text='type Tree = { children: Tree[] };\nfunction view(p: Tree) { return p; }';let g=await parse('lines',text);const before=requestNode(g.nodes.find(n=>n.name==='view'));g=await parse('lines','\n\n'+text);assert.deepEqual(requestNode(g.nodes.find(n=>n.name==='view')),before);assert.equal(before.typeContext.declarations.length,1);
});
