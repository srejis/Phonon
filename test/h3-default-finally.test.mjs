import test from 'node:test';import assert from 'node:assert/strict';import {buildRequest,hypothesis} from '../experiments/h3.mjs';
const base={id:'fixture',language:'python',calls:[],facts:[]};const active=node=>buildRequest({...base,...node},[]).instructions.includes('Python default/state and finally boundary precision');
test('identifier defaults activate explicit default/state contract without new request metadata',()=>{
 const node={...base,parameters:'(path, *, output: Address = GLOBAL_ADDRESS, fallback: Address | None = None)',source:'def f(path, *, output: Address = GLOBAL_ADDRESS, fallback: Address | None = None):\n    return output / path',scopeBindings:[{name:'GLOBAL_ADDRESS',kind:'assignment',scope:'<module>'}]};const request=buildRequest(node,[]);assert.equal(hypothesis.version,26);assert.ok(active(node));const ledger=JSON.parse(request.input).localLedger;assert.equal(ledger.source.map(row=>row.text).join('\n'),node.source);assert.ok(!Object.hasOwn(ledger,'defaultHeuristic'));for(const phrase of ['function definition','keyword-only','only part of a','actually read','every actual return form/boundary'])assert.ok(request.instructions.includes(phrase));
});
test('literal/default None, string data and non-Python do not activate additional instructions',()=>{
 for(const node of [{parameters:'(x=None, y=True, z=3, text="GLOBAL")',source:'def f(x=None, y=True, z=3, text="GLOBAL"):\n    return x'},{parameters:'()',source:'def f():\n    note="try:\\nfinally:"\n    # finally:\n    return note'},{language:'javascript',parameters:'(x=GLOBAL)',source:'try {} finally {}'}])assert.equal(active(node),false);
});
test('actual try/finally preserves whole body including first operation and excludes preceding cleanup',()=>{
 const source='def f():\n    cleanup_before()\n    try:\n        first_operation()\n        validate()\n    finally:\n        cleanup_after()';const request=buildRequest({...base,parameters:'()',source},[]);assert.ok(active({source}));for(const phrase of ['FIRST operation','entire matching try BODY','before the try','guaranteed successful cleanup'])assert.ok(request.instructions.includes(phrase));assert.equal(JSON.parse(request.input).localLedger.source.map(row=>row.text).join('\n'),source);
});
test('try/except without finally and not guard only keep v17-specific instructions',()=>{
 const node={parameters:'(x)',source:'def f(x):\n    if not x:\n        return None\n    try:\n        return evaluate(x)\n    except ValueError:\n        return None'};assert.equal(active(node),false);assert.ok(buildRequest({...base,...node},[]).instructions.includes('Python negated-guard precision'));
});
