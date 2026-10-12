import {callResultUse,declaredPathReceiverProof} from './python-path-contracts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'web-tree-sitter';
import {parseSQL} from './sql-parser.mjs';
import {parseCSS} from './css-parser.mjs';
import {getTypeContext,getPythonTypeContext} from './type-context.mjs';
import {getPythonBuiltinContract} from './python-contracts.mjs';
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
 if(n.type==='typed_parameter')return patternNames(n.childForFieldName('name')??n.namedChildren.find(child=>child.type!=='type'));
 if(['pair_pattern','assignment_pattern','required_parameter','optional_parameter','default_parameter','typed_default_parameter'].includes(n.type))return patternNames(n.childForFieldName('value')&&n.type==='pair_pattern'?n.childForFieldName('value'):n.childForFieldName('pattern')??n.childForFieldName('left')??n.childForFieldName('name'));
 if(['type','type_annotation','type_identifier','predefined_type','attribute','member_expression','subscript','string','string_literal'].includes(n.type))return [];
 return n.namedChildren.flatMap(patternNames);
}
function stringValue(n){return n?.type==='string'?n.namedChildren.map(c=>c.text).join(''):n?.text??'';}
function collectBindings(root,entries,language,fileInfo){
 const moduleScope={name:'<module>',kind:'module',parent:null,bindings:new Map()};
 const scopes=[moduleScope],at=new Map(),pendingAssignments=[],assignmentSources=new WeakMap(),declarationSources=new WeakMap();
 const byAst=new Map(entries.map(e=>[astKey(e.ast),e]));
 function add(scope,name,kind,n,extra={}){
  if(!name)return;
  const binding={name,kind,scope:scope.name,line:n.startPosition.row+1,target:null,targetId:null,status:'unresolved',...extra};
  if(!scope.bindings.has(name))scope.bindings.set(name,[]);scope.bindings.get(name).push(binding);declarationSources.set(binding,n);return binding;
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
 for(const {scope,n,names,target}of pendingAssignments)for(const name of names){const existing=language==='python'?null:nearest(scope,name);const binding=add(existing?.scope??scope,name,'assignment',n,{target});assignmentSources.set(binding,n);}
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
 return {at,scopes,moduleScope,resolve,flatten,assignmentSources,declarationSources};
}

// Source structure only: no prop evaluation, environment execution, value/type inference or edges.
function ownedSourceChecklists(ast,node,bindingInfo,language,source,top=false){
 const result={},jsx=[],writes=[],optional=[],html=[],literalGuards=new Map();
 const point=n=>{const covered=node.lineMap.map((row,index)=>({row,line:index+1})).filter(item=>item.row>=n.startPosition.row+1&&item.row<=n.endPosition.row+1);return {line:covered[0]?.line??0,endLine:covered.at(-1)?.line??0};};
 const own=n=>n.startIndex>=ast.startIndex&&n.endIndex<=ast.endIndex&&point(n).line>0&&point(n).endLine>0;
 const site=n=>({...point(n),source:n.text});
 const resolve=(at,name)=>bindingInfo.resolve(bindingInfo.at.get(astKey(at))??bindingInfo.moduleScope,name);
 function restFor(expression,at){
  if(expression?.type!=='identifier')return null;
  const resolved=resolve(at,expression.text),declaration=bindingInfo.declarationSources.get(resolved.binding);
  if(resolved.status==='candidate'||!declaration||declaration.endIndex>at.startIndex||!own(declaration))return null;
  const pattern=declaration.type==='variable_declarator'?declaration.childForFieldName('name'):null;
  if(pattern?.type!=='object_pattern')return null;
  const rest=pattern.namedChildren.find(c=>c.type==='rest_pattern'&&c.namedChildren[0]?.text===expression.text);
  if(!rest)return null;
  const excludedKeys=pattern.namedChildren.filter(c=>c!==rest).map(c=>{
   const key=c.childForFieldName('key')??c.childForFieldName('left')??c;
   return {source:key.text,computed:key.type==='computed_property_name'};
  });
  return {...site(declaration),pattern:pattern.text,valueSource:declaration.childForFieldName('value')?.text??null,scope:resolved.scope?.name??null,excludedKeys};
 }
 walk(ast,n=>{
  if((top&&(definitions.has(n.type)||isClass(n)))||(n!==ast&&(definitions.has(n.type)||isClass(n))))return;
  if(!own(n))return;

  if(language==='python'&&['if_statement','while_statement'].includes(n.type)){
   const condition=n.childForFieldName('condition');
   if(condition)walk(condition,comparison=>{
    if(comparison.type!=='comparison_operator')return;
    for(let i=1;i<comparison.children.length;i++){
     const candidate=comparison.children[i];
     if(candidate.type!=='identifier'||comparison.children[i-1].text!=='in')continue;
     const resolved=resolve(comparison,candidate.text),declaration=bindingInfo.assignmentSources.get(resolved.binding),literal=declaration?.childForFieldName('right');
     if(resolved.status==='candidate'||!declaration||!own(declaration)||declaration.endIndex>condition.startIndex||literal?.type!=='set'||!literal.namedChildren.every(member=>['string','integer','float','true','false','none','concatenated_string'].includes(member.type)))continue;
     const key=astKey(declaration);if(!literalGuards.has(key))literalGuards.set(key,{name:candidate.text,declaration:site(declaration),literal:site(literal),members:literal.namedChildren.map(site),guards:[]});
     const record=literalGuards.get(key),guard=site(condition);if(!record.guards.some(item=>item.line===guard.line&&item.source===guard.source))record.guards.push(guard);
    }
   });
  }
  if(language==='tsx'&&['jsx_opening_element','jsx_self_closing_element'].includes(n.type)){
   const parts=n.namedChildren.filter(c=>c.type==='jsx_attribute'||c.type==='jsx_expression');
   if(parts.some(c=>c.namedChildren[0]?.type==='spread_element')){
    const properties=parts.map((part,index)=>{const spread=part.namedChildren[0];
     if(spread?.type==='spread_element'){const expression=spread.namedChildren[0];return {index,kind:'spread',...site(part),expression:expression?.text??'',restBinding:restFor(expression,n)};}
     return {index,kind:'explicit',...site(part),name:part.namedChildren[0]?.text??'',valueSource:part.namedChildren.slice(1).map(c=>c.text).join('')};
    });
    let returnAst=n.parent;while(returnAst&&!definitions.has(returnAst.type)&&returnAst.type!=='return_statement')returnAst=returnAst.parent;
    const element=n.parent,children=element?.type==='jsx_element'?element.namedChildren.filter(c=>!['jsx_opening_element','jsx_closing_element'].includes(c.type)).map(site):[];
    jsx.push({...point(n),tag:n.childForFieldName('name')?.text??n.namedChildren[0]?.text??'',openingSource:n.text,properties,children,returnSite:returnAst?.type==='return_statement'&&own(returnAst)?point(returnAst):null});
   }
  }
  if(['javascript','typescript','tsx'].includes(language)){
   if(['assignment_expression','augmented_assignment_expression','update_expression'].includes(n.type)){
    const left=n.childForFieldName('left')??n.childForFieldName('argument'),right=n.childForFieldName('right');
    const operator=n.childForFieldName('operator')?.text??n.children.find(c=>['=','+=','-=','*=','/=','%=','++','--','&&=','||=','??=','**=','&=','|=','^=','<<=','>>=','>>>='].includes(c.text))?.text??'';
    const access=operator==='='?'write':'read_write';
    if(left?.type==='identifier'){
     const resolved=resolve(n,left.text);
     if(resolved.scope?.name==='<module>'&&['const','let','var','assignment'].includes(resolved.binding?.kind))writes.push({...site(n),kind:'module_write',target:left.text,operator,access,bindingScope:resolved.scope.name,rightSource:right?.text??null});
    }else if(['member_expression','subscript_expression'].includes(left?.type)){
     const receiver=left.childForFieldName('object');writes.push({...site(n),kind:'property_write',target:left.text,receiverSource:receiver?.text??'',receiverUse:'write_target_context',operator,access,oldTargetValueRead:access==='read_write',rightSource:right?.text??null});
    }
   }
   if(n.type==='optional_chain'){
    let expression=n.parent;while(expression.parent&&['member_expression','subscript_expression','call_expression','binary_expression','ternary_expression','parenthesized_expression','pair'].includes(expression.parent.type))expression=expression.parent;
    optional.push({...site(n.parent),operator:n.text,baseSource:n.parent.childForFieldName('object')?.text??n.parent.childForFieldName('function')?.text??'',contextSource:expression.text});
   }
  }
  if(language==='html'&&['start_tag','self_closing_tag'].includes(n.type)){
   const attributes=n.namedChildren.filter(c=>c.type==='attribute').map(attribute=>({...site(attribute),name:attribute.namedChildren.find(c=>c.type==='attribute_name')?.text??'',valueSource:attribute.namedChildren.filter(c=>c.type!=='attribute_name').map(c=>c.text).join('')||null}));
   const texts=[],container=n.parent;let run=[];
   const flush=()=>{if(!run.length)return;const first=run[0],last=run.at(-1);texts.push({line:point(first).line,endLine:point(last).endLine,source:source.slice(first.startIndex,last.endIndex)});run=[];};
   for(const child of container?.namedChildren??[]){if(['text','entity','raw_text'].includes(child.type)&&own(child))run.push(child);else flush();}flush();
   html.push({...point(n),tag:n.namedChildren.find(c=>c.type==='tag_name')?.text??'',openingSource:n.text,attributes,texts});
  }
 },n=>n!==ast&&(definitions.has(n.type)||isClass(n))||top&&(definitions.has(n.type)||isClass(n)));
 if(literalGuards.size)result.localLiteralGuardChecklist=[...literalGuards.values()];
 if(jsx.length)result.jsxPropChecklist=jsx;if(writes.length)result.writeChecklist=writes;if(optional.length)result.optionalAccessChecklist=optional;if(html.length)result.htmlDeclarationChecklist=html;
 return result;
}

export async function analyzeFiles(files){
 const nodes=[],filesInfo=[],diagnostics=[];
 for(const file of files){
  const {absolute,source}=safeSource(file),extension=path.extname(absolute),language=grammars[extension]??'sql';
  const sourceLines=source.split(/\r?\n/);const key=absolute.replaceAll('\\','/');
  const fileInfo={file:absolute,hash:hash(source),language,imports:[],exports:[]};filesInfo.push(fileInfo);
  if(language==='css'){
   try{nodes.push(...parseCSS(source,{file:absolute,key}).nodes);}
   catch(error){diagnostics.push({file:absolute,status:'parse_failed',reason:'PostCSS rejected CSS syntax',line:error.line,column:error.column});}
   continue;
  }
  if(language==='sql'){
   try{
    const {ast,dialect,dialectBasis}=parseSQL(source);
    const normalized=canonical(sourceLines,1);
    nodes.push({id:`${key}::sql`,name:path.basename(file),kind:'sql_file',language,sqlDialect:dialect,sqlDialectBasis:dialectBasis,file:absolute,startLine:1,endLine:sourceLines.length,...normalized,facts:[{line:1,kind:'sql_statements',text:JSON.stringify(ast)}],calls:[],scope:null});
   }catch{diagnostics.push({file:absolute,status:'parse_failed',reason:'SQL grammar rejected source; PostgreSQL default or explicit SQLite foreign_keys dialect'});}continue;
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
    const anonymous=name==null;
    if(anonymous){
     const anonymousIndex=entries.filter(entry=>entry.node.anonymous&&entry.node.scope===(scope?.name??null)).length+1;
     name=`anonymous#${anonymousIndex}`;
    }
    let scopeName=scope?.name?`${scope.name}.`:'';
    if(language==='css'){let ancestor=ast.parent;const contexts=[];while(ancestor){if(ancestor.type==='media_statement')contexts.unshift(ancestor.namedChildren[0]?.text??'@media');ancestor=ancestor.parent;}scopeName=contexts.length?contexts.join(' / ')+' / ':'';}
    const baseId=`${key}::${scopeName}${name}`;const occurrence=entries.filter(e=>e.node.name===scopeName+name).length;const id=occurrence?baseId+"#"+(occurrence+1):baseId;
    const lines=source.slice(ast.startIndex,ast.endIndex).split(/\r?\n/);
    const normal=canonical(lines,ast.startPosition.row+1);
    const node={id,name:scopeName+name,kind:ast.type,language,file:absolute,startLine:ast.startPosition.row+1,endLine:ast.endPosition.row+1,...normal,calls:[],facts:[],scope:scope?.name??null,parameters:ast.childForFieldName('parameters')?.text??'',anonymous};
    node.lexicalScopes=[node.name];let lexical=scope;while(lexical){if(lexical.kind==='function')node.lexicalScopes.push(lexical.name);lexical=lexical.parent;}entries.push({ast,node});nodes.push(node);nextScope={name:node.name,kind:'function',parent:scope};
   }
   for(const child of ast.namedChildren)visit(child,nextScope);
  }
  visit(tree.rootNode);
  if(language==='typescript'||language==='tsx')for(const entry of entries)entry.node.typeContext=getTypeContext(tree.rootNode,entry.ast);
  if(language==='python')for(const entry of entries)entry.node.typeContext=getPythonTypeContext(tree.rootNode,entry.ast);
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
  // Constructor assignments own their field setup; consumers use state references, not calls.
  for(const item of classes){
   const methods=entries.filter(entry=>entry.node.scope===item.name&&!entry.classInit);
   const classOwner=entries.find(entry=>entry.classInit&&entry.node.scope===item.name)?.node;
   const constructor=methods.find(entry=>entry.node.name===item.name+(language==='python'?'.__init__':'.constructor'));
   const fieldOwners=(classOwner?.classDefinition?.fieldDetails??[]).map(field=>({...field,ownerId:classOwner.id,kind:'class_declaration'}));
   if(constructor){
    const receiver=language==='python'?patternNames(constructor.ast.childForFieldName('parameters'))[0]:'this';
    walk(constructor.ast,n=>{
     if(!['assignment','assignment_expression'].includes(n.type))return;
     const left=n.childForFieldName('left');
     if(!['attribute','member_expression'].includes(left?.type))return;
     const object=left.childForFieldName('object')?.text;
     const name=left.childForFieldName('attribute')?.text??left.childForFieldName('property')?.text;
     if(object!==receiver||!name)return;
     if(!fieldOwners.some(field=>field.name===name&&field.ownerId===constructor.node.id))fieldOwners.push({name,static:false,ownerId:constructor.node.id,kind:'constructor_assignment'});
    },n=>n!==constructor.ast&&(definitions.has(n.type)||isClass(n)));
    constructor.node.initializedFields=fieldOwners.filter(field=>field.ownerId===constructor.node.id).map(field=>field.name);
   }
   if(!fieldOwners.length)continue;
   for(const entry of methods){
    const decorators=entry.ast.parent?.type==='decorated_definition'?entry.ast.parent.namedChildren.filter(n=>n.type==='decorator').map(n=>n.text):[];
    entry.node.classContext={name:item.name,initializationNodeId:classOwner?.id??constructor?.node.id,
     fieldNames:[...new Set(fieldOwners.map(field=>field.name))],fieldOwners,
     methodStatic:/^\s*static\b/.test(entry.ast.text)||decorators.some(text=>/@(?:staticmethod|classmethod)\b/.test(text)),
     receiver:language==='python'?patternNames(entry.ast.childForFieldName('parameters'))[0]??null:null};
   }
  }
  const bindingInfo=collectBindings(tree.rootNode,entries,language,fileInfo);
  const methodInfo=new Map();
  for(const item of classes){
   const body=item.ast.childForFieldName('body');
   const methods=entries.filter(e=>!e.classInit&&definitions.has(e.ast.type)&&body&&(e.ast.parent&&astKey(e.ast.parent)===astKey(body)||e.ast.parent?.type==='decorated_definition'&&astKey(e.ast.parent.parent)===astKey(body)));
   const overrides=new Set();
   for(const e of methods){
    walk(e.ast,n=>{
     if(!['assignment','assignment_expression','augmented_assignment','augmented_assignment_expression'].includes(n.type))return;
     const left=n.childForFieldName('left'),object=left?.childForFieldName('object')?.text;
     if(object!==(language==='python'?patternNames(e.ast.childForFieldName('parameters'))[0]:'this'))return;
     const field=left?.childForFieldName('attribute')?.text??left?.childForFieldName('property')?.text;if(field)overrides.add(field);
    },n=>n!==e.ast&&((definitions.has(n.type)&&n.type!=='arrow_function')||isClass(n)));
   }
   for(const e of methods){
    const decorators=e.ast.parent?.type==='decorated_definition'?e.ast.parent.namedChildren.filter(n=>n.type==='decorator').map(n=>n.text):[];
    methodInfo.set(astKey(e.ast),{entry:e,methods,className:item.name,decorators,static:/^\s*static\b/.test(e.ast.text)||decorators.some(text=>/@(?:staticmethod|classmethod)\b/.test(text)),receiver:patternNames(e.ast.childForFieldName('parameters'))[0],overrides});
   }
  }
  function receiverMethod(ast){
   for(let current=ast;current;current=current.parent){
    if(methodInfo.has(astKey(current)))return methodInfo.get(astKey(current));
    if(language!=='python'&&definitions.has(current.type)&&current.type!=='arrow_function')return null;
    if(isClass(current))return null;
   }
   return null;
  }
  const constructionClasses=new Map();
  function passesObjectValue(ast,name){
   if(ast?.type==='identifier')return ast.text===name;
   if(!['argument_list','keyword_argument','parenthesized_expression','list','tuple','set','dictionary','pair','list_splat','dictionary_splat'].includes(ast?.type))return false;
   return ast.namedChildren.some(child=>passesObjectValue(child,name));
  }
  if(language==='python'){
   let dynamicReplacement=false;
   walk(tree.rootNode,n=>{if(n.type==='call'&&['setattr','delattr','exec','eval'].includes(n.childForFieldName('function')?.text))dynamicReplacement=true;});
   for(const item of classes){
    if(dynamicReplacement||item.ast.parent?.type!=='module'||item.ast.childForFieldName('superclasses'))continue;
    const binding=bindingInfo.resolve(bindingInfo.moduleScope,item.name);
    if(binding.status==='candidate'||binding.binding?.kind!=='class'||binding.binding.line!==item.ast.startPosition.row+1)continue;
    const methods=[...methodInfo.values()].filter(info=>info.className===item.name);
    if(methods.some(info=>['__new__','__getattr__','__getattribute__','__setattr__'].includes(info.entry.ast.childForFieldName('name')?.text)))continue;
    const initializers=methods.filter(info=>info.entry.ast.childForFieldName('name')?.text==='__init__');
    if(initializers.length!==1||initializers[0].decorators.length)continue;
    const methodNames=new Set(methods.map(info=>info.entry.ast.childForFieldName('name')?.text));
    if(methodNames.size!==methods.length)continue;
    let overridden=methods.some(info=>[...info.overrides].some(name=>methodNames.has(name)||['__class__','__dict__'].includes(name)));
    walk(tree.rootNode,n=>{
     if(n.type==='call'&&passesObjectValue(n.childForFieldName('arguments'),item.name))overridden=true;
     if(!['assignment','augmented_assignment','delete_statement'].includes(n.type))return;
     const left=n.childForFieldName('left')??n.namedChildren[0];
     if(left?.type==='attribute'&&left.childForFieldName('object')?.text===item.name)overridden=true;
     if(n.type==='delete_statement'&&left?.text===item.name||n.childForFieldName('right')?.type==='identifier'&&n.childForFieldName('right').text===item.name)overridden=true;
     if(left)walk(left,part=>{if(part.type==='attribute'&&part.childForFieldName('attribute')?.text==='__dict__')overridden=true;});
    });
    const classFields=entries.find(e=>e.classInit&&e.node.scope===item.name)?.node.classDefinition?.fields??[];
    if(overridden||classFields.some(name=>methodNames.has(name)))continue;
    constructionClasses.set(item.name,{item,methods,binding:binding.binding,initializerId:initializers[0].entry.node.id});
   }
  }
  function constructionFor(scope,name){
   const proof=constructionClasses.get(name),resolved=bindingInfo.resolve(scope,name);
   return proof&&resolved.status!=='candidate'&&resolved.binding===proof.binding?proof:null;
  }
  function instanceFor(scope,name,callAst){
   const resolved=bindingInfo.resolve(scope,name),assignment=bindingInfo.assignmentSources.get(resolved.binding);
   if(resolved.status==='candidate'||!assignment||assignment.type!=='assignment'||assignment.endIndex>=callAst.startIndex)return null;
   const container=assignment.parent?.parent;
   if(container?.type!=='module'&&!(container?.type==='block'&&container.parent?.type==='function_definition'))return null;
   const rhs=assignment.childForFieldName('right'),fn=rhs?.childForFieldName('function');
   if(rhs?.type!=='call'||fn?.type!=='identifier')return null;
   const proof=constructionFor(bindingInfo.at.get(astKey(rhs))??scope,fn.text);if(!proof)return null;
   let invalid=false;
   walk(tree.rootNode,n=>{
    const left=['assignment','augmented_assignment','delete_statement'].includes(n.type)?n.childForFieldName('left')??n.namedChildren[0]:null;
    if(left?.type==='attribute'&&left.childForFieldName('object')?.text===name)invalid=true;
    if(n.type==='delete_statement'&&left?.text===name||n.type==='assignment'&&n.childForFieldName('right')?.type==='identifier'&&n.childForFieldName('right').text===name)invalid=true;
    if(n.type==='call'&&passesObjectValue(n.childForFieldName('arguments'),name))invalid=true;
   });
   return invalid?null:proof;
  }
  const constructionMetadata=proof=>({className:proof.item.name,initializerId:proof.initializerId,result:'new_instance',dependency:'initialization',assumption:'On successful construction of this static local class with no observed replacement, the result is the instance, not the __init__ return value; runtime monkey-patching is unverified.'});
  const callScopes=new WeakMap(),callAsts=new WeakMap();
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
     const ctx=node.classContext;
     for(const detail of ctx.fieldOwners??[]){
      if(detail.name!==field)continue;
      let receiver=false;
      if(object==='this'&&language!=='python')receiver=ctx.methodStatic===detail.static;
      if(object===ctx.receiver&&language==='python'&&!ctx.methodStatic){
       const resolved=bindingInfo.resolve(bindingInfo.at.get(astKey(n))??lexical,object);receiver=resolved.binding?.kind==='parameter'&&resolved.status!=='candidate';
      }
      if(object===ctx.name){const resolved=bindingInfo.resolve(bindingInfo.at.get(astKey(n))??lexical,object);receiver=detail.static&&resolved.binding?.kind==='class'&&resolved.binding.ownerId===detail.ownerId&&resolved.status!=='candidate';}
      if(receiver){
       const parent=n.parent,left=parent?.childForFieldName('left');
       const plainAssignment=['assignment','assignment_expression'].includes(parent?.type)&&left&&astKey(left)===astKey(n);
       if(!plainAssignment&&detail.ownerId!==node.id){
        const readWrite=['update_expression','augmented_assignment','augmented_assignment_expression'].includes(parent?.type)&&(!left||astKey(left)===astKey(n));
        node.references.push({targetId:detail.ownerId,kind:'class_state',line:relative,object,field,access:readWrite?'read_write':'read',stateOrigin:detail.kind});
       }
      }
     }
    }
    if(n.type==='call'||n.type==='call_expression'){
     const fn=n.childForFieldName('function'),name=fn?.text??'';
     const call={name,line:relative,arguments:n.childForFieldName('arguments')?.text??'',resultUse:callResultUse(n),targetId:null,status:'unresolved'};node.calls.push(call);callScopes.set(call,bindingInfo.at.get(astKey(n))??lexical);callAsts.set(call,n);
    }
   }, n=>n!==ast && (definitions.has(n.type)||['class_definition','class_declaration'].includes(n.type)));
   for(const call of node.calls){
    const callScope=callScopes.get(call)??lexical;
    const base=call.name.split('.')[0];const resolved=bindingInfo.resolve(callScope,base);
    call.bindingScope=resolved.scope?.name??null;
    call.shadowed=!!resolved.binding&&resolved.binding.kind!=='import'&&!resolved.targetId;
    if(resolved.binding?.kind==='import')call.importBinding={source:resolved.binding.source,imported:resolved.binding.imported,local:resolved.binding.local,kind:resolved.binding.importKind??resolved.binding.importType??fileInfo.imports.find(i=>i.local===base&&i.source===resolved.binding.source)?.kind,line:resolved.binding.line,level:resolved.binding.level,typeOnly:resolved.binding.typeOnly};
    if(/^[A-Za-z_$][\w$]*$/.test(call.name)&&resolved.targetId){call.targetId=resolved.targetId;call.status='confirmed_same_file';}
    else if(language==='python'&&/^[A-Za-z_]\w*$/.test(call.name)&&constructionFor(callScope,call.name)){
     const proof=constructionFor(callScope,call.name);call.targetId=proof.initializerId;call.status='confirmed_local_construction';call.shadowed=false;call.construction=constructionMetadata(proof);
    }
    else if(/^(?:this|self)\.[A-Za-z_$][\w$]*$/.test(call.name)){
     const owner=receiverMethod(ast),member=call.name.slice(call.name.indexOf('.')+1);
     const receiverValid=owner&&(language==='python'?!owner.static&&base===owner.receiver&&resolved.binding?.kind==='parameter'&&resolved.binding.scope===owner.entry.node.name&&resolved.status!=='candidate':base==='this');
     const fieldOverride=owner&&(owner.overrides.has(member)||owner.entry.node.classContext?.fieldNames?.includes(member));
     if(receiverValid&&!fieldOverride){
      const matching=owner.methods.filter(e=>e.ast.childForFieldName('name')?.text===member);
      const candidates=owner.methods.filter(e=>{const info=methodInfo.get(astKey(e.ast));return e.ast.childForFieldName('name')?.text===member&&(language==='python'?(!info.static&&!info.decorators.length||info.decorators.length===1&&info.decorators[0]==='@staticmethod'&&!bindingInfo.resolve(callScope,'staticmethod').binding):info.static===owner.static);});
      if(language==='python'&&matching.length>1||candidates.length>1)call.status='ambiguous';
      else if(candidates.length===1){call.targetId=candidates[0].node.id;call.status='confirmed_same_file';call.shadowed=false;}
     }
    }
    else if(language==='python'&&/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(call.name)){
     const proof=instanceFor(callScope,base,callAsts.get(call)),member=call.name.split('.')[1];
     const candidates=proof?.methods.filter(info=>info.entry.ast.childForFieldName('name')?.text===member&&(!info.decorators.length||info.decorators.length===1&&info.decorators[0]==='@staticmethod'&&!bindingInfo.resolve(callScope,'staticmethod').binding))??[];
     if(candidates.length===1){call.targetId=candidates[0].entry.node.id;call.status='confirmed_local_instance';call.shadowed=false;call.instanceProvenance=constructionMetadata(proof);}
     else if(candidates.length>1)call.status='ambiguous';
    }
    else if(resolved.status==='candidate')call.status='candidate';
    if(!call.targetId&&call.status==='unresolved'&&resolved.status==='candidate')call.status='candidate';
   }
   node.externalContracts=[];
   if(language==='python')for(const call of node.calls.filter(c=>c.name==='print'&&!c.targetId&&!bindingInfo.resolve(callScopes.get(c)??lexical,'print').binding)){
    call.status='standard_builtin_contract';
    node.externalContracts.push({name:'print',input:'objects plus optional sep/end/file/flush',process:'Convert supplied objects to strings and write to file; defaults are sep=space, end=newline, file=sys.stdout.',output:'Observable text output; return None.',returns:['None'],effects:['텍스트 출력 요청'],source:'https://docs.python.org/3/library/functions.html#print',assumption:'Standard Python builtins without runtime monkey-patching; lexical bindings were excluded.'});
   }
   if(language==='python')for(const call of node.calls){
    const contract=getPythonBuiltinContract(call,{language,lexicalUnshadowed:!bindingInfo.resolve(callScopes.get(call)??lexical,call.name).binding});
    if(contract){call.status='standard_builtin_contract';node.externalContracts.push(contract);}
   }
   if(language==='python')for(const call of node.calls){
    const callAst=callAsts.get(call),fn=callAst?.childForFieldName('function'),method=fn?.childForFieldName('attribute')?.text;
    if(call.targetId||!['mkdir','with_suffix','unlink','open','is_file','resolve'].includes(method)||fn?.type!=='attribute')continue;
    const proof=declaredPathReceiverProof(ast,fn.childForFieldName('object'),callAst,{resolveAt:(at,name)=>bindingInfo.resolve(bindingInfo.at.get(astKey(at))??lexical,name)});
    if(proof){call.declaredPathProvenance=proof;call.declaredPathMethod=method;}
   }
   node.references=node.references.filter((reference,index,all)=>all.findIndex(item=>item.targetId===reference.targetId&&item.line===reference.line&&item.object===reference.object&&item.field===reference.field&&item.access===reference.access)===index);
   node.facts=node.facts.filter((f,i,a)=>a.findIndex(x=>x.line===f.line&&x.kind===f.kind&&x.text===f.text)===i);
   Object.assign(node,ownedSourceChecklists(ast,node,bindingInfo,language,source,entry.top));
  }
  // Lexical callback ownership is a definition reference, never evidence of invocation.
  for(const child of entries.filter(e=>['arrow_function','function_expression'].includes(e.ast.type))){
   let parent=child.ast.parent,owner=null;
   while(parent){owner=entries.find(e=>!e.classInit&&!e.top&&astKey(e.ast)===astKey(parent));if(owner)break;if(isClass(parent))break;parent=parent.parent;}
   if(!owner&&!parent)owner=entries.find(e=>e.top);
   if(!owner)continue;
   const line=owner.node.lineMap.indexOf(child.ast.startPosition.row+1)+1;
   if(line>0)owner.node.references.push({targetId:child.node.id,kind:'callback_definition',line,relationship:'lexical_definition',invocation:false});
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
