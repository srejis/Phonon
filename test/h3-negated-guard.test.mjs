import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildRequest,hypothesis} from '../experiments/h3.mjs';
const fixtures = [{"id":"normalized","language":"python","source":"def normalized(path):\n    return str(path.resolve())","calls":[],"facts":[]},{"id":"readmeta","language":"python","source":"def readmeta(path):\n    try:\n        return read(path)\n    except Exception:\n        return None","calls":[],"facts":[]}];
const previousHashes = ["ba0ca427efeaf54c704e14c1f503fd5c050ac6ee945a99445006cd721a8bec92","8db739309e39bf2a557d9df66bfb35b71381412084d544fa345689b2262fffe8"];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('apart from explicit v20 language instructions, non-negated base requests retain v16 bytes for two fixtures',()=>{
 assert.equal(hypothesis.version,28);
 fixtures.forEach((node,index)=>{const request=buildRequest(node,[]);request.instructions=request.instructions.replace(/\n응답 언어 계약:[\s\S]*?설명 자체를 한국어로 쓰세요\./,'').replace(/\n최종 언어 확인:[^\n]*$/,'');assert.equal(fingerprint(request),previousHashes[index]);});
});
test('source negation preserves full predicate and separates False, scoped exceptions and child information',()=>{
 const source='def check(root_value, summary, files_present):\n    if not isinstance(root_value, str) or not isinstance(summary, dict) or not files_present:\n        return None';
 const node={id:'guard',language:'python',source,facts:[{line:2,kind:'if_statement',text:source.split('\n').slice(1).join('\n')}],calls:[]};
 const request=buildRequest(node,[]),ledger=JSON.parse(request.input).localLedger;
 assert.equal(ledger.source.map(row=>row.text).join('\n'),source);
 assert.equal(ledger.directFacts[0].text,node.facts[0].text);
 for(const clause of ['complete source predicate','positive call list','predicate returning False','outside that try','parsed metadata marker','SAME response'])assert.ok(request.instructions.includes(clause));
});
test('not in strings/comments or another language does not activate the Python guard instructions',()=>{
 for(const node of [{id:'s',language:'python',source:'def f(x):\n    note = "if not x:"\n    # if not x:\n    if x:\n        return note'},{id:'s',language:'python',source:'def f(x):\n    note = """\nif not x:\n"""\n    return note'},{id:'s',language:'javascript',source:'if not x:'}])assert.ok(!buildRequest(node,[]).instructions.includes('Python negated-guard precision'));
});
test('multiline grouped and elif negation are detected without adding input fields',()=>{
 for(const source of ['def f(a,b):\n    if (\n        not a or not b\n    ):\n        return None','def f(a,b):\n    if a:\n        return a\n    elif not b:\n        return None'])assert.ok(buildRequest({id:'s',language:'python',source},[]).instructions.includes('Python negated-guard precision'));
});
