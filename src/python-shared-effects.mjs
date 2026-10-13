/** Conditional source contract for a captured, directly initialized standard list.
 * No execution, values, new call edges or child-prose interpretation. */
const key=n=>n&&n.type+':'+n.startIndex+':'+n.endIndex;
const walk=(n,fn)=>{fn(n);for(const c of n.namedChildren)walk(c,fn);};
const field=(n,name)=>n?.childForFieldName(name);
const same=(a,b)=>key(a)===key(b);
const line=(node,ast)=>node.lineMap.indexOf(ast.startPosition.row+1)+1;

export function pythonSharedEffectContracts(entries,bindingInfo,callAsts){
 const result=new Map(),byId=new Map(entries.map(e=>[e.node.id,e]));
 const resolve=(at,name)=>bindingInfo.resolve(bindingInfo.at.get(key(at))??bindingInfo.moduleScope,name);
 function actions(child){
  if(child.ast.type!=='function_definition')return [];
  const out=[];
  for(const call of child.node.calls){
   const ast=callAsts.get(call),fn=field(ast,'function'),receiver=field(fn,'object');
   if(fn?.type!=='attribute'||field(fn,'attribute')?.text!=='append'||receiver?.type!=='identifier')continue;
   const args=field(ast,'arguments')?.namedChildren??[];
   if(args.length!==1||['list_splat','dictionary_splat','keyword_argument'].includes(args[0].type))continue;
   const resolved=resolve(receiver,receiver.text),binding=resolved.binding;
   if(resolved.status==='candidate'||binding?.kind!=='assignment'||binding.target||binding.targetId||resolved.scope?.kind!=='function')continue;
   const declaration=bindingInfo.declarationSources.get(binding),left=field(declaration,'left'),rhs=field(declaration,'right');
   if(declaration?.type!=='assignment'||left?.type!=='identifier'||left.text!==receiver.text||rhs?.type!=='list'||rhs.namedChildren.length)continue;
   const statement=declaration.parent?.type==='expression_statement'?declaration.parent:declaration;
   const block=statement.parent,ownerAst=block?.parent;
   if(block?.type!=='block'||ownerAst?.type!=='function_definition'||!same(field(ownerAst,'body'),block)||declaration.endIndex>=child.ast.startIndex)continue;
   const owner=entries.find(e=>same(e.ast,ownerAst));
   if(!owner||resolved.scope.name!==owner.node.name||!same(bindingInfo.declarationSources.get(binding),bindingInfo.assignmentSources.get(binding)))continue;
   // The defining owner must enclose this child, not be an unrelated same-named scope.
   let ancestor=child.ast.parent;while(ancestor&&!same(ancestor,ownerAst))ancestor=ancestor.parent;if(!ancestor)continue;
   let invalid=false;
   const refers=n=>n?.type==='identifier'&&resolve(n,n.text).binding===binding;
   const contains=n=>{let yes=false;if(n)walk(n,x=>{if(refers(x))yes=true;});return yes;};
   // Passing the list value, including literal containers, defeats this narrow proof.
   // A generator's iterable read does not itself pass that list as the argument value.
   const escapingValue=n=>{
    if(['list_comprehension','set_comprehension','dictionary_comprehension','generator_expression'].includes(n?.type))return contains(field(n,'body'));
    if(n?.type==='conditional_expression')return contains(n);
    return refers(n)||(['list','tuple','set','dictionary','pair','keyword_argument','list_splat','dictionary_splat'].includes(n?.type)&&n.namedChildren.some(escapingValue));
   };
   walk(ownerAst,n=>{
    if(invalid||same(n,declaration))return;
    if(['nonlocal_statement','global_statement'].includes(n.type)&&n.namedChildren.some(x=>x.text===binding.name))invalid=true;
    if(['assignment','augmented_assignment'].includes(n.type)){
     const target=field(n,'left');
     if(refers(target)||target?.type==='attribute'&&refers(field(target,'object'))||target?.type==='subscript'&&refers(field(target,'value')))invalid=true;
     // Aliasing this list into another assignment is outside this narrow proof.
     if(contains(field(n,'right')))invalid=true;
    }
    if(n.type==='delete_statement'&&contains(n))invalid=true;
    if(n.type==='call'){
     const method=field(n,'function');
     if(method?.type==='attribute'&&refers(field(method,'object'))&&field(method,'attribute')?.text!=='append')invalid=true;
     if(field(n,'arguments')?.namedChildren.some(escapingValue))invalid=true;
    }
   });
   if(invalid)continue;
   const childLine=line(child.node,ast),declarationLine=line(owner.node,declaration);
   if(childLine<1||declarationLine<1)continue;
   out.push({targetBinding:{name:binding.name,scope:binding.scope,ownerId:owner.node.id},declaration:{ownerLine:declarationLine,kind:'direct_empty_list_literal'},action:{kind:'list_append_request',childLine,resultUse:call.resultUse},returns:['None'],effect:'append_one_item_to_captured_outer_list',condition:'only if execution reaches this child action',assumption:'The captured binding continues to refer to the directly initialized standard list without unobserved rebinding or method replacement. Argument evaluation and append may fail; no successful mutation, actual contents or item value/type is established.',source:'https://docs.python.org/3.14/builtins/stdtypes.html#mutable-sequence-types'});
  }
  return out;
 }
 const memo=new Map();
 for(const caller of entries){
  const contracts=[];
  for(const call of caller.node.calls){
   const child=byId.get(call.targetId),site=callAsts.get(call);
   if(!child||child===caller||call.status!=='confirmed_same_file'||field(site,'function')?.type!=='identifier')continue;
   const callable=resolve(site,call.name);
   if(callable.status!=='resolved'||callable.binding?.kind!=='function'||callable.targetId!==child.node.id||!same(bindingInfo.declarationSources.get(callable.binding),child.ast))continue;
   if(!memo.has(child.node.id))memo.set(child.node.id,actions(child));
   for(const action of memo.get(child.node.id))contracts.push({childId:child.node.id,callSite:{line:call.line,name:call.name,resultUse:call.resultUse},callableBinding:{name:callable.binding.name,scope:callable.binding.scope,kind:'function',role:'lexical_callable_and_closure_context'},...action});
  }
  if(contracts.length)result.set(caller.node.id,contracts);
 }
 return result;
}
