import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyGroups} from '../src/dependency-groups.mjs';

const node = (id, targets = [], line = 1) => ({id, startLine: line, endLine: line + 3,
  calls: targets.map(targetId => ({targetId, line}))});
const groupOf = (groups, id) => groups.find(group => group.members.some(member => member.id === id));
const summary = groups => groups.map(group => ({id: group.id, members: group.members.map(n => n.id),
  cyclic: group.cyclic, dependencies: group.dependencies}));

test('mutual recursion retains every member and visits external leaf dependencies first', () => {
  const graph = {nodes: [node('a', ['b', 'leaf']), node('b', ['a']), node('leaf'), node('free')]};
  const groups = dependencyGroups(graph), cycle = groupOf(groups, 'a'), leaf = groupOf(groups, 'leaf');
  assert.deepEqual(cycle.members.map(n => n.id), ['a', 'b']);
  assert.equal(cycle.cyclic, true);
  assert.deepEqual(cycle.dependencies, [leaf.id]);
  assert.ok(groups.indexOf(leaf) < groups.indexOf(cycle));
  assert.equal(groupOf(groups, 'free').cyclic, false);
  assert.deepEqual(groups.flatMap(g => g.members.map(n => n.id)).sort(), ['a', 'b', 'free', 'leaf']);
  assert.equal(cycle.members[0], graph.nodes[0]);
});

test('self recursion is cyclic and unresolved/external calls do not create groups', () => {
  const groups = dependencyGroups({nodes: [node('self', ['self', null, 'external']), node('isolated')]});
  assert.equal(groups.length, 2);
  assert.equal(groupOf(groups, 'self').cyclic, true);
  assert.deepEqual(groupOf(groups, 'self').dependencies, []);
  assert.equal(groupOf(groups, 'isolated').cyclic, false);
});

test('multiple SCCs retain all members with dependency-first order', () => {
  const groups = dependencyGroups({nodes: [node('a', ['b', 'c']), node('b', ['a']),
    node('c', ['d', 'leaf']), node('d', ['c']), node('leaf')]});
  const first = groupOf(groups, 'a'), second = groupOf(groups, 'c'), leaf = groupOf(groups, 'leaf');
  assert.deepEqual(first.members.map(n => n.id), ['a', 'b']);
  assert.deepEqual(second.members.map(n => n.id), ['c', 'd']);
  assert.deepEqual(first.dependencies, [second.id]);
  assert.deepEqual(second.dependencies, [leaf.id]);
  assert.ok(groups.indexOf(leaf) < groups.indexOf(second));
  assert.ok(groups.indexOf(second) < groups.indexOf(first));
  assert.deepEqual(groups.flatMap(g => g.members.map(n => n.id)).sort(), ['a', 'b', 'c', 'd', 'leaf']);
});

test('group identity and order ignore input order, duplicate calls, and line movement', () => {
  const original = [node('a', ['b', 'leaf']), node('b', ['a']), node('leaf'), node('free')];
  const moved = original.toReversed().map(n => ({...n, startLine: 100, endLine: 200,
    calls: n.calls.toReversed().flatMap(c => [{...c, line: 100}, {...c, line: 101}])}));
  assert.deepEqual(summary(dependencyGroups({nodes: original})), summary(dependencyGroups({nodes: moved})));
});

test('empty graphs work and duplicate identities are rejected', () => {
  assert.deepEqual(dependencyGroups({nodes: []}), []);
  assert.throws(() => dependencyGroups({nodes: [node('same'), node('same')]}), /unique/);
});

test('actual state references order initializer ownership first without inventing call edges', () => {
 const state = node('initializer'), method = {...node('method'), references:[
  {targetId:'initializer',kind:'class_state',line:2,field:'value',object:'self',access:'read'},
  {targetId:null,kind:'class_state',line:3}
 ]};
 const groups = dependencyGroups({nodes:[method,state]}), stateGroup=groupOf(groups,'initializer'), methodGroup=groupOf(groups,'method');
 assert.ok(groups.indexOf(stateGroup)<groups.indexOf(methodGroup));
 assert.deepEqual(methodGroup.dependencies,[stateGroup.id]);
 assert.deepEqual(methodGroup.members[0].calls,[]);
 const cycle=dependencyGroups({nodes:[{...node('a'),references:[{targetId:'b',kind:'class_state'}]},node('b',['a'])]});
 assert.equal(cycle.length,1);assert.equal(cycle[0].cyclic,true);
 assert.deepEqual(cycle[0].members.map(n=>n.id),['a','b']);
});
