const scopeTypes=new Set(['program','statement_block']);
const definitions=new Set(['function_declaration','function_expression','arrow_function','method_definition','class_declaration']);
const key=n=>`${n.type}:${n.startIndex}:${n.endIndex}`;
function scopeOf(node){for(let p=node.parent;p;p=p.parent)if(scopeTypes.has(p.type))return p;return null;}
function typeReferences(node,skipNested=false){const result=[];function visit(n){if(n!==node&&skipNested&&definitions.has(n.type))return;if(n.type==='type_identifier'){const scopes=[];for(let p=n;p;p=p.parent)if(scopeTypes.has(p.type))scopes.push(p);result.push({name:n.text,scopes});}for(const child of n.namedChildren)visit(child);}visit(node);return result;}

// Type annotations explain declared contracts; they never create runtime call edges.
export function getTypeContext(root,definition){
 const declarations=[];function collect(n){if(['type_alias_declaration','interface_declaration'].includes(n.type)){const name=n.childForFieldName('name')?.text;if(name)declarations.push({name,node:n,scope:scopeOf(n)});}for(const child of n.namedChildren)collect(child);}collect(root);
 const result=[],unresolved=new Set(),ambiguous=new Set(),seen=new Set();
 const queue=typeReferences(definition,true);
 while(queue.length){const item=queue.shift();let matches=[];for(const scope of item.scopes){matches=declarations.filter(d=>d.name===item.name&&key(d.scope)===key(scope));if(matches.length)break;}
  if(matches.length>1){ambiguous.add(item.name);continue;}if(!matches.length){unresolved.add(item.name);continue;}
  const found=matches[0],id=key(found.node);if(seen.has(id))continue;seen.add(id);
  result.push({name:found.name,kind:found.node.type,source:found.node.text});
  for(const reference of typeReferences(found.node).filter(r=>r.name!==found.name))queue.push(reference);
 }
 return {declarations:result,unresolvedTypeNames:[...unresolved].sort(),ambiguousTypeNames:[...ambiguous].sort(),interpretation:'Source-declared type contracts only; imported/library structures and runtime value conformance are unverified.'};
}

const pythonScopes=new Set(['module','block']);
const pythonBuiltinTypes=new Set(['str','int','bool','float','complex','bytes','list','dict','tuple','set','frozenset','object','None']);
export function getPythonTypeContext(root,definition){
 const classes=[];const scopesOf=node=>{const scopes=[];for(let p=node;p;p=p.parent)if(pythonScopes.has(p.type))scopes.push(p);return scopes;};
 function collect(n){if(n.type==='class_definition')classes.push({name:n.childForFieldName('name')?.text,node:n,scopes:scopesOf(n.parent)});for(const child of n.namedChildren)collect(child);}collect(root);
 const result=[],seen=new Set(),unknown=new Set();
 function resolve(name,scopes){for(const scope of scopes){const found=classes.filter(c=>c.name===name&&c.scopes[0]&&key(c.scopes[0])===key(scope));if(found.length)return found.length===1?found[0]:null;}return null;}
 function references(n,scopeList,skipNested=false){if(n!==definition&&skipNested&&['function_definition','class_definition'].includes(n.type))return;if(n.type==='type'){function names(t){if(t.type==='identifier'){const found=resolve(t.text,scopeList??scopesOf(n));if(found)include(found);}for(const child of t.namedChildren)names(child);}names(n);return;}for(const child of n.namedChildren)references(child,scopeList,skipNested);}
 function include(cls){const id=key(cls.node);if(seen.has(id))return;seen.add(id);const annotations=[];
  for(const statement of cls.node.childForFieldName('body')?.namedChildren??[]){const assignment=statement.type==='expression_statement'?statement.namedChildren[0]:statement;if(assignment?.type!=='assignment')continue;const left=assignment.childForFieldName('left'),type=assignment.childForFieldName('type');if(left?.type!=='identifier'||!type)continue;annotations.push({name:left.text,type:type.text,source:assignment.text});function types(n){if(n.type==='identifier'&&!pythonBuiltinTypes.has(n.text)){const other=resolve(n.text,cls.scopes);if(other)include(other);else unknown.add(n.text);}for(const child of n.namedChildren)types(child);}types(type);}
  result.push({name:cls.name,kind:'python_class_annotation_contract',annotations,inheritance:cls.node.childForFieldName('superclasses')?.text??null});
 }
 references(definition,null,true);
 return {declarations:result,unresolvedTypeNames:[...unknown].sort(),ambiguousTypeNames:[],interpretation:'Same-file declared class field annotations only; no constructor execution, runtime conformance, inherited field or imported type structure is established.'};
}
