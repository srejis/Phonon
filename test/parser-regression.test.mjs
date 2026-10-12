import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFiles, dependencyOrder, ROOT } from '../src/parser.mjs';

const fixtureRoot = path.join(ROOT, '.local', 'test-fixtures', 'parser-regression');
async function fixture(name, source) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const file = path.join(fixtureRoot, name);
  await fs.writeFile(file, source, 'utf8');
  return { file, graph: await analyzeFiles([file]) };
}
function named(graph, name) {
  const matches = graph.nodes.filter(n => n.name === name);
  assert.equal(matches.length, 1, `exactly one node named ${name}`);
  return matches[0];
}
function callNamed(node, name) {
  const matches = node.calls.filter(c => c.name === name);
  assert.equal(matches.length, 1, `exactly one ${name} call in ${node.name}`);
  return matches[0];
}

test('same-file function calls resolve and dependencies precede callers', async () => {
  const { graph } = await fixture('direct.py', 'def twice(value):\n    return value * 2\n\ndef use(value):\n    return twice(value) + 1\n');
  assert.deepEqual(graph.diagnostics, []);
  const child = named(graph, 'twice'), parent = named(graph, 'use');
  assert.equal(callNamed(parent, 'twice').targetId, child.id);
  assert.equal(callNamed(parent, 'twice').status, 'confirmed_same_file');
  assert.equal(parent.startLine, 4);
  assert.equal(parent.endLine, 5);
  assert.equal(parent.source, 'def use(value):\n    return twice(value) + 1');
  const order = dependencyOrder(graph).map(n => n.id);
  assert.ok(order.indexOf(child.id) < order.indexOf(parent.id));
});

test('a parameter shadows a global function rather than confirming a false edge', async () => {
  const { graph } = await fixture('parameter-shadow.py', 'def transform(value):\n    return value + 1\n\ndef invoke(transform, value):\n    return transform(value)\n');
  const call = callNamed(named(graph, 'invoke'), 'transform');
  assert.equal(call.targetId, null);
  assert.equal(call.status, 'unresolved');
});

test('nested function has its own range and calls do not leak into its parent', async () => {
  const { graph } = await fixture('nested-scope.py', 'def helper(value):\n    return value * 2\n\ndef outer(value):\n    def inner(item):\n        return helper(item)\n    return inner(value)\n');
  const inner = named(graph, 'outer.inner'), outer = named(graph, 'outer');
  assert.equal(inner.startLine, 5);
  assert.equal(inner.endLine, 6);
  assert.equal(inner.source, 'def inner(item):\n        return helper(item)');
  assert.equal(callNamed(inner, 'helper').targetId, named(graph, 'helper').id);
  assert.deepEqual(outer.calls.map(c => c.name), ['inner']);
});

test('an enclosing function call resolves its directly defined nested function', async () => {
  const { graph } = await fixture('nested-binding.py', 'def outer(value):\n    def inner(item):\n        return item * 2\n    return inner(value)\n');
  assert.equal(callNamed(named(graph, 'outer'), 'inner').targetId, named(graph, 'outer.inner').id);
});

test('a nested local function shadows a same-named global function', async () => {
  const { graph } = await fixture('nested-shadow.py', 'def transform(value):\n    return value - 1\n\ndef outer(value):\n    def transform(item):\n        return item * 2\n    return transform(value)\n');
  const outer = named(graph, 'outer');
  assert.equal(callNamed(outer, 'transform').targetId, named(graph, 'outer.transform').id);
});

test('same-named class methods keep distinct identities and self calls resolve per class', async () => {
  const { graph } = await fixture('class-methods.py', 'class First:\n    def transform(self, value):\n        return value + 1\n    def invoke(self, value):\n        return self.transform(value)\n\nclass Second:\n    def transform(self, value):\n        return value * 2\n    def invoke(self, value):\n        return self.transform(value)\n');
  assert.deepEqual(graph.diagnostics, []);
  const first = named(graph, 'First.transform'), second = named(graph, 'Second.transform');
  assert.notEqual(first.id, second.id);
  assert.equal(callNamed(named(graph, 'First.invoke'), 'self.transform').targetId, first.id);
  assert.equal(callNamed(named(graph, 'Second.invoke'), 'self.transform').targetId, second.id);
});

test('invalid syntax records parse_failed and creates no partial nodes', async () => {
  const { graph } = await fixture('broken.py', 'def broken(:\n    return 1\n');
  assert.deepEqual(graph.nodes, []);
  assert.equal(graph.diagnostics.length, 1);
  assert.equal(graph.diagnostics[0].status, 'parse_failed');
});

test('moving unchanged named functions down preserves identity and canonical source', async () => {
  const source = 'def twice(value):\n    return value * 2\n\ndef use(value):\n    return twice(value) + 1\n';
  const first = await fixture('line-move.py', source);
  await fs.writeFile(first.file, '\n\n\n' + source, 'utf8');
  const moved = await analyzeFiles([first.file]);
  for (const name of ['twice', 'use']) {
    const before = named(first.graph, name), after = named(moved, name);
    assert.equal(after.id, before.id);
    assert.equal(after.source, before.source);
    assert.equal(after.startLine, before.startLine + 3);
    assert.equal(after.endLine, before.endLine + 3);
    assert.deepEqual(after.lineMap, before.lineMap.map(line => line + 3));
    assert.deepEqual(after.calls, before.calls);
    assert.deepEqual(after.facts, before.facts);
  }
});

test('an imported target remains explicitly unresolved within the current support limit', async () => {
  const { graph } = await fixture('import-limit.py', 'from unknown_fixture_module import transform\n\ndef invoke(value):\n    return transform(value)\n');
  const call = callNamed(named(graph, 'invoke'), 'transform');
  assert.equal(call.targetId, null);
  assert.equal(call.status, 'unresolved');
  assert.ok(graph.limits.some(limit => limit.includes('imports') && limit.includes('unresolved')));
});
