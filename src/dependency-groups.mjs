import {createHash} from 'node:crypto';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Confirmed-call/reference SCCs in dependency-first order; does not create semantic hierarchy. */
export function dependencyGroups(graph) {
  if (!Array.isArray(graph?.nodes)) throw new TypeError('Graph nodes must be an array');
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new TypeError('Node requires a nonempty string id');
    if (nodes.has(node.id)) throw new TypeError('Graph node ids must be unique');
    nodes.set(node.id, node);
  }
  const ids = [...nodes.keys()].sort(compare);
  const edges = new Map(ids.map(id => [id, [...new Set(
    [...(Array.isArray(nodes.get(id).calls) ? nodes.get(id).calls : []),
      ...(Array.isArray(nodes.get(id).references) ? nodes.get(id).references : [])]
      .map(call => call?.targetId).filter(target => nodes.has(target))
  )].sort(compare)]));
  let nextIndex = 0;
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
  function visit(id) {
    index.set(id, nextIndex); low.set(id, nextIndex++);
    stack.push(id); onStack.add(id);
    for (const target of edges.get(id)) {
      if (!index.has(target)) {
        visit(target); low.set(id, Math.min(low.get(id), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id), index.get(target)));
      }
    }
    if (low.get(id) === index.get(id)) {
      const members = [];
      let member;
      do {member = stack.pop(); onStack.delete(member); members.push(member);} while (member !== id);
      components.push(members.sort(compare));
    }
  }
  for (const id of ids) if (!index.has(id)) visit(id);

  const groupForNode = new Map();
  const groups = components.map(memberIds => {
    const id = 'scc-' + createHash('sha256').update(JSON.stringify(memberIds)).digest('hex');
    for (const memberId of memberIds) groupForNode.set(memberId, id);
    return {id, members: memberIds.map(memberId => nodes.get(memberId)),
      cyclic: memberIds.length > 1 || edges.get(memberIds[0]).includes(memberIds[0]), dependencies: []};
  });
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) {
    group.dependencies = [...new Set(group.members.flatMap(node => edges.get(node.id)
      .map(target => groupForNode.get(target)).filter(id => id !== group.id)))].sort(compare);
  }
  const ordered = [], visited = new Set();
  function order(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const group = byId.get(id);
    for (const dependency of group.dependencies) order(dependency);
    ordered.push(group);
  }
  for (const id of [...byId.keys()].sort(compare)) order(id);
  return ordered;
}
