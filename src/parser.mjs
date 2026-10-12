import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'web-tree-sitter';
import sql from 'node-sql-parser';
export const VERSION='parser-2';
export const ROOT=path.resolve(import.meta.dirname,'..');
export const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const grammars={'.py':'python','.ts':'typescript','.tsx':'tsx','.js':'javascript','.jsx':'tsx','.html':'html','.css':'css'};
const definitions=new Set(['function_definition','function_declaration','generator_function_declaration','method_definition','arrow_function','function_expression']);
const factTypes=new Set(['return_statement','if_statement','for_statement','while_statement','assignment','augmented_assignment','binary_operator','binary_expression','call','call_expression','declaration','attribute','subscript','update_expression']);
const loaded=new Map();
let initialized;
async function parserFor(language){
 initialized ??= Parser.init(); await initialized;
 if(!loaded.has(language)) loaded.set(language,await Parser.Language.load(path.join(ROOT,'node_modules/tree-sitter-wasms/out',`tree-sitter-${language}.wasm`)));
 const parser=new Parser();parser.setLanguage(loaded.get(language));return parser;
}
export function safeSource(file){
 const absolute=fs.realpathSync(file);
 if(!absolute.toLowerCase().startsWith('d:\\project\\')) throw new Error('Sources must be inside D:\\project');
 if(!grammars[path.extname(absolute)] && path.extname(absolute)!=='.sql') throw new Error('Unsupported source extension');
 if(fs.statSync(absolute).size>300000) throw new Error('Source exceeds initial 300KB file limit');
 const source=fs.readFileSync(absolute,'utf8');
 return {absolute,source};
}
function walk(node,callback,stop){ callback(node);if(stop?.(node))return; for(const child of node.namedChildren)walk(child,callback,stop); }
function canonical(lines,start){
 const mapping=[],kept=[];
 lines.forEach((line,i)=>{if(line.trim()){mapping.push(start+i);kept.push(line.trimEnd());}});
 return {source:kept.join('\n'),lineMap:mapping};
}
const astKey=n=>`${n.type}:${n.startIndex}:${n.endIndex}`;
const isClass=n=>['class_definition','class_declaration'].includes(n.type);
const identifierTypes=new Set(['identifier','shorthand_property_identifier_pattern']);
function patternNames(n){
 if(!n)return [];
 if(identifierTypes.has(n.type))return [n.text];
 if(['pair_pattern','assignment_pattern','required_parameter','optional_parameter','default_parameter','typed_default_parameter'].includes(n.type))return patternNames(n.childForFieldName('value')&&n.type==='pair_pattern'?n.childForFieldName('value'):n.childForFieldName('pattern')??n.childForFieldName('left')??n.childForFieldName('name'));
 if(['type_annotation','type_identifier','predefined_type','attribute','member_expression','subscript','string','string_literal'].includes(n.type))return [];
 return n.namedChildren.flatMap(patternNames);
}
function stringValue(n){return n?.type==='string'?n.namedChildren.map(c=>c.text).join(''):n?.text??'';}
function collectBindings(root,entries,language,fileInfo){
 const moduleScope={name:'<module>',kind:'module',parent:null,bindings:new Map()};
 const scopes=[moduleScope],at=new Map(),pendingAssignments=[];
 const byAst=new Map(entries.map(e=>[astKey(e.ast),e]));
 function add(scope,name,kind,n,extra={}){
  if(!name)return;
  const binding={name,kind,scope:scope.name,line:n.startPosition.row+1,target:null,targetId:null,status:'unresolved',...extra};
  if(!scope.bindings.has(name))scope.bindings.set(name,[]);scope.bindings.get(name).push(binding);return binding;
 }
 function declarePattern(scope,n,kind,owner,extra={}){for(const name of patternNames(n))add(scope,name,kind,owner,extra);}
 function importItem(scope,n,record){fileInfo.imports.push(record);add(scope,record.local,'import',n,{...record,kind:'import',importKind:record.kind,target:null,targetId:null,status:'unresolved',scope:scope.name});}
 function imports(n,scope){
  if(n.type==='import_statement'&&language!=='python'){
   const source=stringValue(n.childForFieldName('source'));const clause=n.namedChildren.find(c=>c.type==='import_clause');
   for(const child of clause?.namedChildren??[]){
    if(child.type==='identifier')importItem(scope,n,{source,imported:'default',local:child.text,kind:'default',line:n.startPosition.row+1,typeOnly:/^import\s+type\b/.test(n.text)});
    if(child.type==='namespace_import'){const local=child.namedChildren.find(c=>c.type==='identifier')?.text;importItem(scope,n,{source,imported:'*',local,kind:'namespace',line:n.startPosition.row+1});}
    if(child.type==='named_imports')for(const item of child.namedChildren){const name=item.childForFieldName('name')?.text,local=item.childForFieldName('alias')?.text??name;importItem(scope,item,{source,imported:name,local,kind:'named',line:item.startPosition.row+1,typeOnly:/^type\s/.test(item.text)||/^import\s+type\b/.test(n.text)});}
   }
  }else if(language==='python'&&['import_statement','import_from_statement'].includes(n.type)){
   const from=n.type==='import_from_statement',module=n.childForFieldName('module_name');
   for(const item of n.namedChildren.filter(c=>(!module||astKey(c)!==astKey(module))&&!['relative_import','import_prefix'].includes(c.type))){
    const imported=item.type==='aliased_import'?item.childForFieldName('name')?.text:item.text;
    const local=item.type==='aliased_import'?item.childForFieldName('alias')?.text:(from?imported:imported?.split('.')[0]);
    if(!imported)continue;
    const source=from?module?.text??'':imported;
    const record={source,imported:from?imported:'*',local,kind:from?'python_from':'python_import',line:item.startPosition.row+1,level:from?(source.match(/^\.+/)?.[0].length??0):0};
    importItem(scope,item,record);
   }
  }
 }
 function scan(n,scope){
  if(definitions.has(n.type)){
   const entry=byAst.get(astKey(n));
   const name=n.childForFieldName('name')?.text;
   if(name)add(scope,name,'function',n,{targetId:entry?.node.id??null,status:entry?'resolved':'unresolved'});
   const next={name:entry?.node.name??`function@${n.startPosition.row+1}`,kind:'function',parent:scope,bindings:new Map()};scopes.push(next);at.set(astKey(n),next);
   declarePattern(next,n.childForFieldName('parameters'),'parameter',n);
   // A single-argument arrow stores its parameter separately.
   declarePattern(next,n.childForFieldName('parameter'),'parameter',n);
   for(const child of n.namedChildren)scan(child,next);return;
  }
  if(isClass(n)){
   const name=n.childForFieldName('name')?.text;add(scope,name,'class',n,{ownerId:byAst.get(astKey(n))?.node.id??null});
   const next={name,kind:'class',parent:scope,bindings:new Map()};scopes.push(next);at.set(astKey(n),next);
   for(const child of n.namedChildren)scan(child,next);return;
  }
  if(language!=='python'&&['statement_block','catch_clause','for_statement','for_in_statement'].includes(n.type)){
   scope.blockCount=(scope.blockCount??0)+1;const next={name:scope.name+'#'+n.type+':'+scope.blockCount,kind:'block',parent:scope,bindings:new Map()};scopes.push(next);scope=next;
  }
  at.set(astKey(n),scope);
  imports(n,scope);
  if(n.type==='variable_declarator'){
   const declaration=n.parent;const kind=/^\s*const\b/.test(declaration?.text??'')?'const':/^\s*let\b/.test(declaration?.text??'')?'let':'var';
   let targetScope=scope;if(kind==='var')while(targetScope.kind==='block')targetScope=targetScope.parent;
   const value=n.childForFieldName('value'),direct=byAst.get(value?astKey(value):'');
   declarePattern(targetScope,n.childForFieldName('name'),kind,n,{target:value?.type==='identifier'?value.text:null,targetId:direct?.node.id??null,status:direct?'resolved':'unresolved'});
  }
  if(['assignment','augmented_assignment','assignment_expression','augmented_assignment_expression','update_expression'].includes(n.type)){
   const left=n.childForFieldName('left')??n.childForFieldName('argument');
   const right=n.childForFieldName('right');
   pendingAssignments.push({scope,n,names:patternNames(left),target:n.type==='assignment'||n.type==='assignment_expression'?right?.type==='identifier'?right.text:null:null});
  }
  if(n.type==='for_statement'&&language==='python')declarePattern(scope,n.childForFieldName('left'),'for',n);
  if(n.type==='for_in_statement'&&language!=='python')declarePattern(scope,n.childForFieldName('left'),'for',n);
  if(n.type==='as_pattern')declarePattern(scope,n.childForFieldName('alias'),n.parent?.type==='except_clause'?'catch':'with',n);
  if(n.type==='catch_clause')declarePattern(scope,n.childForFieldName('parameter'),'catch',n);
  if(['public_field_definition','field_definition','property_definition'].includes(n.type))add(scope,n.childForFieldName('name')?.text,'field',n);
  for(const child of n.namedChildren)scan(child,scope);
 }
 scan(root,moduleScope);
 function nearest(scope,name,skipClass=false){for(let current=scope;current;current=current.parent){if(skipClass&&current.kind==='class')continue;if(current.bindings.has(name))return {scope:current,items:current.bindings.get(name)};}return null;}
 for(const {scope,n,names,target}of pendingAssignments)for(const name of names){const existing=language==='python'?null:nearest(scope,name);add(existing?.scope??scope,name,'assignment',n,{target});}
 function resolve(scope,name,seen=new Set()){
  const found=nearest(scope,name,true);if(!found)return {targetId:null,status:'unresolved',binding:null};
  const {items}=found,first=items[0];
  if(items.length!==1)return {targetId:null,status:'candidate',binding:first,scope:found.scope};
  if(first.targetId)return {targetId:first.targetId,status:'resolved',binding:first,scope:found.scope};
  const key=found.scope.name+':'+name;if(seen.has(key))return {targetId:null,status:'candidate',binding:first,scope:found.scope};
  if(first.target){seen.add(key);const result=resolve(found.scope,first.target,seen);return {...result,binding:first,scope:found.scope};}
  return {targetId:null,status:'unresolved',binding:first,scope:found.scope};
 }
 // Exports are AST declarations/specifiers; preserve static names, not guessed paths.
 for(const statement of root.namedChildren.filter(n=>n.type==='export_statement')){
  const sourceNode=statement.childForFieldName('source'),source=sourceNode?stringValue(sourceNode):null;
  const clause=statement.namedChildren.find(c=>c.type==='export_clause');
  if(clause)for(const item of clause.namedChildren){const local=item.childForFieldName('name')?.text,exported=item.childForFieldName('alias')?.text??local;fileInfo.exports.push({exported,local,imported:local,source,kind:'named',typeOnly:/^export\s+type\b/.test(statement.text)||/^type\s/.test(item.text),line:item.startPosition.row+1,targetId:source?null:resolve(moduleScope,local).targetId});}
  else if(source)fileInfo.exports.push({exported:'*',local:null,imported:'*',source,kind:'star',typeOnly:/^export\s+type\b/.test(statement.text),line:statement.startPosition.row+1,targetId:null});
  else{
   const declaration=statement.childForFieldName('declaration')??statement.childForFieldName('value')??statement.namedChildren[0];
   const names=declaration?.type==='lexical_declaration'||declaration?.type==='variable_declaration'?declaration.namedChildren.flatMap(c=>patternNames(c.childForFieldName('name'))):[declaration?.childForFieldName('name')?.text].filter(Boolean);
   const defaultExport=/^export\s+default\b/.test(statement.text);
   for(const name of names)fileInfo.exports.push({exported:defaultExport?'default':name,local:name,source:null,kind:defaultExport?'default':'named',line:statement.startPosition.row+1,targetId:resolve(moduleScope,name).targetId});
   if(defaultExport&&!names.length)fileInfo.exports.push({exported:'default',local:null,source:null,kind:'default',line:statement.startPosition.row+1,targetId:byAst.get(declaration?astKey(declaration):'')?.node.id??null});
  }
 }
 if(language==='python')for(const [name,items]of moduleScope.bindings){const binding=items[0];fileInfo.exports.push({exported:name,local:name,source:binding.kind==='import'?binding.source:null,imported:binding.kind==='import'?binding.imported:name,kind:'named',line:binding.line,targetId:resolve(moduleScope,name).targetId});}
 const flatten=scope=>{const result=[];for(let current=scope;current;current=current.parent){if(current.kind==='class'&&scope.kind!=='class')continue;for(const items of current.bindings.values())result.push(...items);}return result;};
 return {at,scopes,moduleScope,resolve,flatten};
}
export async function analyzeFiles(files){
 const nodes=[],filesInfo=[],diagnostics=[];
 for(const file of files){
  const {absolute,source}=safeSource(file),extension=path.extname(absolute),language=grammars[extension]??'sql';
  const sourceLines=source.split(/\r?\n/);const key=absolute.replaceAll('\\','/');
  const fileInfo={file:absolute,hash:hash(source),language,imports:[],exports:[]};filesInfo.push(fileInfo);
  if(language==='sql'){
   try{
    const ast=new sql.Parser().astify(source,{database:'Postgresql'});
    const normalized=canonical(sourceLines,1);
    nodes.push({id:`${key}::sql`,name:path.basename(file),kind:'sql_file',language,file:absolute,startLine:1,endLine:sourceLines.length,...normalized,facts:[{line:1,kind:'sql_statements',text:JSON.stringify(ast)}],calls:[],scope:null});
   }catch{diagnostics.push({file:absolute,status:'parse_failed',reason:'SQL Postgresql grammar rejected source'});}continue;
  }
  const parser=await parserFor(language),tree=parser.parse(source);
  if(tree.rootNode.hasError()){diagnostics.push({file:absolute,status:'parse_failed',reason:'Tree-sitter ERROR or missing syntax'});tree.delete();parser.delete();continue;}
  const entries=[],classes=[];
  function visit(ast,scope=null){
   let nextScope=scope;
   if(isClass(ast)){nextScope={name:ast.childForFieldName('name')?.text,kind:'class',parent:scope};classes.push({ast,name:nextScope.name});}
   let isDefinition=definitions.has(ast.type);
   if(language==='html'){let ancestor=ast.parent;let nested=false;while(ancestor){if(ancestor.type==='element')nested=true;ancestor=ancestor.parent;}isDefinition=ast.type==='element'&&!nested;}
   if(language==='css')isDefinition=ast.type==='rule_set';
   if(isDefinition){
    let name=ast.childForFieldName('name')?.text;
    if(!name && ast.parent?.type==='variable_declarator')name=ast.parent.childForFieldName('name')?.text;
    if(!name && language==='css')name=ast.namedChildren[0]?.text;
    if(!name && language==='html')name=ast.namedChildren[0]?.text;
    name??=`anonymous@${ast.startPosition.row+1}`;
    let scopeName=scope?.name?`${scope.name}.`:'';
    if(language==='css'){let ancestor=ast.parent;const contexts=[];while(ancestor){if(ancestor.type==='media_statement')contexts.unshift(ancestor.namedChildren[0]?.text??'@media');ancestor=ancestor.parent;}scopeName=contexts.length?contexts.join(' / ')+' / ':'';}
    const baseId=`${key}::${scopeName}${name}`;const occurrence=entries.filter(e=>e.node.id===baseId||e.node.id.startsWith(baseId+"#")).length;const id=(language==="css"||language==="html")&&occurrence?baseId+"#"+(occurrence+1):baseId;
    const lines=source.slice(ast.startIndex,ast.endIndex).split(/\r?\n/);
    const normal=canonical(lines,ast.startPosition.row+1);
    const node={id,name:scopeName+name,kind:ast.type,language,file:absolute,startLine:ast.startPosition.row+1,endLine:ast.endPosition.row+1,...normal,calls:[],facts:[],scope:scope?.name??null,parameters:ast.childForFieldName('parameters')?.text??''};
    node.lexicalScopes=[node.name];let lexical=scope;while(lexical){if(lexical.kind==='function')node.lexicalScopes.push(lexical.name);lexical=lexical.parent;}entries.push({ast,node});nodes.push(node);nextScope={name:node.name,kind:'function',parent:scope};
   }
   for(const child of ast.namedChildren)visit(child,nextScope);
  }
  visit(tree.rootNode);
  if(['python','typescript','javascript','tsx'].includes(language)){
   const topStatements=tree.rootNode.namedChildren.filter(n=>!definitions.has(n.type)&& !['class_definition','class_declaration','decorated_definition'].includes(n.type)&&!(n.type==='export_statement'&&n.namedChildren.some(c=>definitions.has(c.type)||c.type==='class_declaration')));
   const hasExecution=topStatements.some(n=>!['import_statement','import_from_statement','comment','expression_statement'].includes(n.type) || (n.type==='expression_statement'&&!['string','string_literal'].includes(n.namedChildren[0]?.type)));
   if(hasExecution){
    const mask=sourceLines.map(()=> '');
    for(const n of topStatements)for(let row=n.startPosition.row;row<=n.endPosition.row;row++)mask[row]=sourceLines[row];
    const normal=canonical(mask,1);
    const node={id:`${key}::top_level`,name:'top_level',kind:'top_level',language,file:absolute,startLine:1,endLine:sourceLines.length,...normal,calls:[],facts:[],scope:null,parameters:''};
    entries.push({ast:tree.rootNode,node,top:true});nodes.push(node);
   }
  }
  for(const item of classes){
   const body=item.ast.childForFieldName('body');
   const fields=(body?.namedChildren??[]).filter(n=>!definitions.has(n.type)&&!isClass(n)&&n.type!=='comment'&&(language==='python'||['public_field_definition','field_definition','property_definition','class_static_block'].includes(n.type)));
   if(!fields.length)continue;
   const kept=[],mapping=[];
   for(const field of fields){const normalized=canonical(field.text.split(/\r?\n/),field.startPosition.row+1);kept.push(normalized.source);mapping.push(...normalized.lineMap);}
   const id=`${key}::${item.name}.top_level`;
   const fieldDetails=fields.flatMap(field=>{
    const assignment=field.namedChildren.find(n=>n.type==='assignment');
    const names=field.childForFieldName('name')?[field.childForFieldName('name').text]:patternNames(assignment?.childForFieldName('left'));
    return names.map(name=>({name,static:language==='python'||/^\s*static\b/.test(field.text)}));
   });
   const node={id,name:item.name+'.top_level',kind:'top_level',language,file:absolute,startLine:Math.min(...mapping),endLine:Math.max(...mapping),source:kept.join('\n'),lineMap:mapping,calls:[],facts:[],scope:item.name,parameters:'',classDefinition:{name:item.name,ownerId:id,fields:fieldDetails.map(f=>f.name),fieldDetails},ownership:'class_initialization'};
   entries.push({ast:item.ast,node,classInit:true});nodes.push(node);
   for(const e of entries.filter(e=>e.node.scope===item.name&&!e.classInit)){
    const decorators=e.ast.parent?.type==='decorated_definition'?e.ast.parent.namedChildren.filter(n=>n.type==='decorator').map(n=>n.text):[];
    e.node.classContext={name:item.name,initializationNodeId:id,fieldNames:node.classDefinition.fields,methodStatic:/^\s*static\b/.test(e.ast.text)||decorators.some(text=>/@(?:staticmethod|classmethod)\b/.test(text)),receiver:patternNames(e.ast.childForFieldName('parameters'))[0]??null};
   }
  }
  const bindingInfo=collectBindings(tree.rootNode,entries,language,fileInfo);
  const callScopes=new WeakMap();
  for(const entry of entries){
   const {ast,node}=entry;const lexical=bindingInfo.at.get(astKey(ast))??bindingInfo.moduleScope;node.references=[];node.scopeBindings=bindingInfo.flatten(lexical);node.bindings=bindingInfo.scopes.filter(s=>s===lexical||s.kind==='block'&&s.name.startsWith(lexical.name+'#')).flatMap(s=>[...s.bindings.values()].flat());
   walk(ast,n=>{
    if(entry.top && (definitions.has(n.type)||['class_definition','class_declaration'].includes(n.type)))return;
    if(n!==ast && definitions.has(n.type))return;
    const actualLine=n.startPosition.row+1,relative=node.lineMap.indexOf(actualLine)+1;
    if(relative<=0)return;
    if(factTypes.has(n.type))node.facts.push({line:relative,kind:n.type,text:n.text});
    if(node.classContext&&['attribute','member_expression'].includes(n.type)){
     const object=n.childForFieldName('object')?.text,field=n.childForFieldName('attribute')?.text??n.childForFieldName('property')?.text;
     const ctx=node.classContext,owner=nodes.find(candidate=>candidate.id===ctx.initializationNodeId);
     const detail=owner?.classDefinition?.fieldDetails.find(item=>item.name===field);
     let receiver=false;
     if(detail&&object==='this'&&language!=='python')receiver=ctx.methodStatic===detail.static;
     if(detail&&object==='self'&&language==='python'&&!ctx.methodStatic&&ctx.receiver==='self'){
      const resolved=bindingInfo.resolve(bindingInfo.at.get(astKey(n))??lexical,'self');receiver=resolved.binding?.kind==='parameter'&&resolved.status!=='candidate';
     }
     if(detail&&object===ctx.name){const resolved=bindingInfo.resolve(bindingInfo.at.get(astKey(n))??lexical,object);receiver=detail.static&&resolved.binding?.kind==='class'&&resolved.binding.ownerId===ctx.initializationNodeId&&resolved.status!=='candidate';}
     if(receiver){
      const parent=n.parent,left=parent?.childForFieldName('left');
      const plainAssignment=['assignment','assignment_expression'].includes(parent?.type)&&left&&astKey(left)===astKey(n);
      if(!plainAssignment){
       const readWrite=['update_expression','augmented_assignment','augmented_assignment_expression'].includes(parent?.type)&&(!left||astKey(left)===astKey(n));
       node.references.push({targetId:ctx.initializationNodeId,kind:'class_state',line:relative,object,field,access:readWrite?'read_write':'read'});
      }
     }
    }
    if(n.type==='call'||n.type==='call_expression'){
     const fn=n.childForFieldName('function'),name=fn?.text??'';
     const call={name,line:relative,arguments:n.childForFieldName('arguments')?.text??'',targetId:null,status:'unresolved'};node.calls.push(call);callScopes.set(call,bindingInfo.at.get(astKey(n))??lexical);
    }
   }, n=>n!==ast && (definitions.has(n.type)||['class_definition','class_declaration'].includes(n.type)));
   for(const call of node.calls){
    const callScope=callScopes.get(call)??lexical;
    const base=call.name.split('.')[0];const resolved=bindingInfo.resolve(callScope,base);
    call.bindingScope=resolved.scope?.name??null;
    call.shadowed=!!resolved.binding&&resolved.binding.kind!=='import'&&!resolved.targetId;
    if(resolved.binding?.kind==='import')call.importBinding={source:resolved.binding.source,imported:resolved.binding.imported,local:resolved.binding.local,kind:resolved.binding.importKind??resolved.binding.importType??fileInfo.imports.find(i=>i.local===base&&i.source===resolved.binding.source)?.kind,line:resolved.binding.line,level:resolved.binding.level,typeOnly:resolved.binding.typeOnly};
    if(/^[A-Za-z_$][\w$]*$/.test(call.name)&&resolved.targetId){call.targetId=resolved.targetId;call.status='confirmed_same_file';}
    else if(call.name.startsWith('self.')&&node.scope){const candidates=entries.filter(e=>e.node.name===`${node.scope}.${call.name.slice(5)}`);if(candidates.length===1){call.targetId=candidates[0].node.id;call.status='confirmed_same_file';}else if(candidates.length>1)call.status='ambiguous';}
    else if(resolved.status==='candidate')call.status='candidate';
   }
   node.externalContracts=[];
   if(language==='python')for(const call of node.calls.filter(c=>c.name==='print'&&!c.targetId&&!bindingInfo.resolve(callScopes.get(c)??lexical,'print').binding)){
    call.status='standard_builtin_contract';
    node.externalContracts.push({name:'print',input:'objects plus optional sep/end/file/flush',process:'Convert supplied objects to strings and write to file; defaults are sep=space, end=newline, file=sys.stdout.',output:'Observable text output; return None.',source:'https://docs.python.org/3/library/functions.html#print',assumption:'Standard Python builtins without runtime monkey-patching; lexical bindings were excluded.'});
   }
   node.references=node.references.filter((reference,index,all)=>all.findIndex(item=>item.targetId===reference.targetId&&item.line===reference.line&&item.object===reference.object&&item.field===reference.field&&item.access===reference.access)===index);
   node.facts=node.facts.filter((f,i,a)=>a.findIndex(x=>x.line===f.line&&x.kind===f.kind&&x.text===f.text)===i);
  }
  tree.delete();parser.delete();
 }
 const ids=new Set();for(const n of nodes){if(ids.has(n.id))diagnostics.push({nodeId:n.id,status:'ambiguous_node_identity'});ids.add(n.id);}
 return {version:VERSION,files:filesInfo,nodes,diagnostics,limits:['Calls resolved only within the same file; imports and dynamic targets remain unresolved.','HTML uses root elements; CSS uses rules; SQL uses a parsed file unit. Cross-language relationships unverified.']};
}
export function dependencyOrder(graph){
 const byId=new Map(graph.nodes.map(n=>[n.id,n])),order=[],active=new Set(),done=new Set();
 function visit(id){if(done.has(id))return;if(active.has(id))throw new Error(`Cyclic dependency requires a separate verified experiment: ${id}`);active.add(id);
  for(const c of [...byId.get(id).calls,...(byId.get(id).references??[])])if(c.targetId&&byId.has(c.targetId))visit(c.targetId);
  active.delete(id);done.add(id);order.push(byId.get(id));}
 for(const node of graph.nodes)visit(node.id);return order;
}
export function requestNode(node){
 const locationFree=b=>{const {line,...rest}=b;return rest;};
 return {...node,file:path.basename(node.file),startLine:1,endLine:node.lineMap.length,lineMap:undefined,
  bindings:node.bindings?.map(locationFree),scopeBindings:node.scopeBindings?.map(locationFree),
  calls:node.calls.map(call=>({...call,importBinding:call.importBinding?locationFree(call.importBinding):undefined}))};
}
