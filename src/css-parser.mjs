import postcss from 'postcss';

/** Parse untouched CSS. No plugins, transformations, source imports or recovery masking. */
export function parseCSS(source,{file,key=file.replaceAll('\\','/')}={}){
 const root=postcss.parse(source,{from:file});
 const nodes=[],occurrences=new Map();
 const normal=(text,start)=>{const kept=[],lineMap=[];text.split(/\r?\n/).forEach((line,index)=>{if(line.trim()){kept.push(line.trimEnd());lineMap.push(start+index);}});return {source:kept.join('\n'),lineMap};};
 // PostCSS offsets use a start-inclusive/end-exclusive range, including the
 // closing brace or statement/declaration semicolon in the original source.
 const raw=node=>source.slice(node.source.start.offset,node.source.end.offset);
 const contexts=node=>{
  const result=[];
  for(let parent=node.parent;parent&&parent.type!=='root';parent=parent.parent){
   if(parent.type==='atrule')result.unshift({kind:'at_rule',name:parent.name,params:parent.params,header:`@${parent.name}${parent.params?' '+parent.params:''}`});
   else if(parent.type==='rule')result.unshift({kind:'rule',selector:parent.selector});
  }
  return result;
 };
 root.walk(ast=>{
  if(ast.type!=='rule'&&ast.type!=='atrule')return;
  // Container at-rules are preserved on every descendant; declaration/statement
  // at-rules such as font-face/import need their own explanation node.
  if(ast.type==='atrule'&&ast.nodes?.some(n=>n.type==='rule'||n.type==='atrule'))return;
  const cssContext=contexts(ast),selector=ast.type==='rule'?ast.selector:`@${ast.name}${ast.params?' '+ast.params:''}`;
  const prefix=cssContext.map(c=>c.kind==='rule'?c.selector:c.name==='media'?c.params:c.header).join(' / ');
  const name=(prefix?prefix+' / ':'')+selector;
  const baseId=`${key}::${name}`,occurrence=occurrences.get(baseId)??0;occurrences.set(baseId,occurrence+1);
  const normalized=normal(raw(ast),ast.source.start.line);
  const node={id:baseId+(occurrence?'#'+(occurrence+1):''),name,kind:ast.type==='rule'?'rule_set':'at_rule',language:'css',file,
   startLine:ast.source.start.line,endLine:ast.source.end.line,...normalized,calls:[],references:[],facts:[],scope:null,parameters:'',anonymous:false,
   lexicalScopes:[name],bindings:[],scopeBindings:[],externalContracts:[],cssContext};
  function facts(current){
   for(const child of current.nodes??[]){
    if(child.type==='rule')continue;
    const line=normalized.lineMap.indexOf(child.source.start.line)+1;
    if(child.type==='decl'&&line>0)node.facts.push({line,kind:'declaration',text:raw(child)});
    else if(child.type==='atrule')facts(child);
   }
  }
  facts(ast);nodes.push(node);
 });
 return {nodes};
}
