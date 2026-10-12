import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'web-tree-sitter';
import sql from 'node-sql-parser';
export const VERSION='parser-1';
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
export async function analyzeFiles(files){
 const nodes=[],filesInfo=[],diagnostics=[];
 for(const file of files){
  const {absolute,source}=safeSource(file),extension=path.extname(absolute),language=grammars[extension]??'sql';
  const sourceLines=source.split(/\r?\n/);const key=absolute.replaceAll('\\','/');
  filesInfo.push({file:absolute,hash:hash(source),language});
  if(language==='sql'){
   try{
    const ast=new sql.Parser().astify(source,{database:'Postgresql'});
    const normalized=canonical(sourceLines,1);
    nodes.push({id:`${key}::sql`,name:path.basename(file),kind:'sql_file',language,file:absolute,startLine:1,endLine:sourceLines.length,...normalized,facts:[{line:1,kind:'sql_statements',text:JSON.stringify(ast)}],calls:[],scope:null});
   }catch{diagnostics.push({file:absolute,status:'parse_failed',reason:'SQL Postgresql grammar rejected source'});}continue;
  }
  const parser=await parserFor(language),tree=parser.parse(source);
  if(tree.rootNode.hasError()){diagnostics.push({file:absolute,status:'parse_failed',reason:'Tree-sitter ERROR or missing syntax'});tree.delete();parser.delete();continue;}
  const entries=[];
  function visit(ast,scope=null){
   let nextScope=scope;
   if(ast.type==='class_definition'||ast.type==='class_declaration') nextScope={name:ast.childForFieldName('name')?.text,kind:'class',parent:scope};
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
  let printRebound=false;
  walk(tree.rootNode,n=>{
   if(definitions.has(n.type)&&n.childForFieldName('name')?.text==='print')printRebound=true;
   if(['assignment','augmented_assignment','variable_declarator'].includes(n.type)&&n.childForFieldName('left')?.text==='print')printRebound=true;
   if(['import_statement','import_from_statement'].includes(n.type)&&/\bprint\b/.test(n.text))printRebound=true;
  });
  for(const entry of entries){
   const {ast,node}=entry;
   walk(ast,n=>{
    if(entry.top && (definitions.has(n.type)||['class_definition','class_declaration'].includes(n.type)))return;
    if(n!==ast && definitions.has(n.type))return;
    const actualLine=n.startPosition.row+1,relative=node.lineMap.indexOf(actualLine)+1;
    if(relative<=0)return;
    if(factTypes.has(n.type))node.facts.push({line:relative,kind:n.type,text:n.text});
    if(n.type==='call'||n.type==='call_expression'){
     const fn=n.childForFieldName('function'),name=fn?.text??'';
     node.calls.push({name,line:relative,arguments:n.childForFieldName('arguments')?.text??'',targetId:null,status:'unresolved'});
    }
   }, n=>n!==ast && (definitions.has(n.type)||['class_definition','class_declaration'].includes(n.type)));
   for(const call of node.calls){
    let candidates=[];
    if(/^[A-Za-z_$][\w$]*$/.test(call.name) && !node.parameters.match(new RegExp(`\\b${call.name}\\b`))){
     for(const lexicalName of (node.lexicalScopes??[])){candidates=entries.filter(e=>e.node.name===`${lexicalName}.${call.name}`);if(candidates.length)break;}
     if(!candidates.length)candidates=entries.filter(e=>e.node.name===call.name&&e.node.scope===null);
     const shadow=node.facts.some(f=>f.kind==='assignment' && new RegExp(`^${call.name}\\s*=`).test(f.text));
     if(shadow)candidates=[];
    } else if(call.name.startsWith('self.') && node.scope) candidates=entries.filter(e=>e.node.name===`${node.scope}.${call.name.slice(5)}`);
    if(candidates.length===1){call.targetId=candidates[0].node.id;call.status='confirmed_same_file';}
    else if(candidates.length>1)call.status='ambiguous';
   }
   node.externalContracts=[];
   if(language==='python'&&!printRebound&&!/\bprint\b/.test(node.parameters)){
    for(const call of node.calls.filter(c=>c.name==='print'&&!c.targetId)){
     call.status='standard_builtin_contract';
     node.externalContracts.push({name:'print',input:'objects plus optional sep/end/file/flush',process:'Convert supplied objects to strings and write to file; defaults are sep=space, end=newline, file=sys.stdout.',output:'Observable text output; return None.',source:'https://docs.python.org/3/library/functions.html#print',assumption:'Standard Python builtins without runtime monkey-patching; local rebindings/imports were excluded.'});
    }
   }
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
  for(const c of byId.get(id).calls)if(c.targetId&&byId.has(c.targetId))visit(c.targetId);
  active.delete(id);done.add(id);order.push(byId.get(id));}
 for(const node of graph.nodes)visit(node.id);return order;
}
export function requestNode(node){return {...node,file:path.basename(node.file),startLine:1,endLine:node.lineMap.length,lineMap:undefined};}