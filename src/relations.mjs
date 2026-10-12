import {getDeclaredPathContract} from './python-path-contracts.mjs';
import {getPythonModuleContract} from './python-module-contracts.mjs';
import path from 'node:path';
import fs from 'node:fs';

const key = file => path.resolve(file).toLowerCase();
const unique = values => [...new Set(values)];
const inRoot = (root, file) => {
  const rel = path.relative(root, path.resolve(file));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
function commonRoot(files) {
  let root = path.dirname(path.resolve(files[0].file));
  for (const file of files) while (!inRoot(root, file.file)) {
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return root;
}

/** Resolve only explicit static module bindings among files already in this graph.
 * No source contents are read, discovered, copied or modified by this module. Only explicit in-project module-path existence is checked for boundary classification.
 * Parser importBinding/shadowed metadata is authoritative for lexical lookup.
 */
export async function resolveRelations(graph, {projectRoot} = {}) {
  const files = graph.files ?? [], nodes = graph.nodes ?? [];
  if (!files.length) return graph;
  const root = path.resolve(projectRoot ?? commonRoot(files));
  const fileMap = new Map();
  for (const file of files) if (inRoot(root, file.file)) {
    const id = key(file.file);
    const prior = fileMap.get(id) ?? [];
    prior.push(file); fileMap.set(id, prior);
  }
  const nodeMap = new Map();
  for (const node of nodes) {
    const values = nodeMap.get(node.id) ?? [];
    values.push(node); nodeMap.set(node.id, values);
  }
  const recordsFor = file => nodes.filter(node => key(node.file) === key(file.file));
  const validTargets = ids => unique(ids).filter(id => nodeMap.has(id));
  function modules(caller, source) {
    if (typeof source !== 'string' || !source) return {files:[],reason:'unresolved_path'};
    const python = caller.language === 'python';
    let candidates=[];
    if (python) {
      const leading = source.match(/^\.+/)?.[0].length ?? 0;
      const remainder = source.slice(leading);
      if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(remainder) && remainder !== '') return {files:[],reason:'unresolved_path'};
      let base = leading ? path.dirname(caller.file) : root;
      for (let i=1;i<leading;i++) base=path.dirname(base);
      const target = remainder ? path.join(base,...remainder.split('.')) : base;
      candidates = remainder ? [target+'.py',path.join(target,'__init__.py')] : [path.join(target,'__init__.py')];

    } else {
      if (!source.startsWith('.')) return {files:[],reason:'external_boundary'};
      const target=path.resolve(path.dirname(caller.file),source),extension=path.extname(target);
      if (extension) {
        candidates=[target];
        if (['.js','.jsx','.mjs'].includes(extension)) candidates.push(target.slice(0,-extension.length)+'.ts',target.slice(0,-extension.length)+'.tsx');
      } else candidates=[target,...['.ts','.tsx','.js','.jsx','.mjs','.cjs'].map(ext=>target+ext),...['.ts','.tsx','.js','.jsx','.mjs','.cjs'].map(ext=>path.join(target,'index'+ext))];
    }
    const matched=[];
    let escaped=false;
    for (const candidate of unique(candidates)) {
      if (!inRoot(root,candidate)) { escaped=true; continue; }
      matched.push(...(fileMap.get(key(candidate))??[]));
    }
    if (!matched.length && python && !source.startsWith('.')) {
      // Check only the two explicit in-project module candidates, never read their source.
      // Existing but unselected local modules remain unresolved; packages outside this
      // static project path are boundary references, without claiming their implementation.
      const localExists=candidates.some(candidate=>inRoot(root,candidate) && (fs.existsSync(candidate) || path.basename(candidate)==='__init__.py' && fs.existsSync(path.dirname(candidate))));
      if(!localExists)return {files:[],reason:'external_boundary'};
    }
    if (matched.length!==1) return {files:matched,reason:matched.length>1?'ambiguous':escaped?'outside_project_scope':'unresolved_path'};
    return {files:matched,reason:null};
  }
  function moduleBindings(file, name) {
    const found=recordsFor(file).flatMap(node=>node.scopeBindings??node.bindings??[])
      .filter(item=>[null,'module','<module>'].includes(item.scope) && item.name===name);
    return [...new Map(found.map(item=>[JSON.stringify(item),item])).values()];
  }
  function localTargets(file, local, targetId) {
    const bindings=moduleBindings(file,local);
    if(bindings.length>1)return [];
    if(targetId)return validTargets([targetId]);
    if(bindings.length===1)return bindings[0].targetId?validTargets([bindings[0].targetId]):[];
    return recordsFor(file).filter(node=>node.scope===null && node.name===local && node.kind!=='top_level').map(node=>node.id);
  }
  function localImport(file, local, seen=new Set()) {
    if(seen.has(local))return null;seen.add(local);
    const bindings=moduleBindings(file,local);
    if(bindings.length>1)return null;
    const binding=bindings[0];
    if(binding?.kind==='import')return {...binding,kind:binding.importKind??binding.kind};
    if(binding?.target)return localImport(file,binding.target,seen);
    if(binding)return null;
    const imports=(file.imports??[]).filter(item=>item.local===local);
    return imports.length===1?imports[0]:null;
  }
  function exported(file, symbol, visited=new Set()) {
    const marker=key(file.file)+'::'+symbol;
    if (visited.has(marker)) return {ids:[],reason:'reexport_cycle',reexport:true};
    const next=new Set(visited); next.add(marker);
    const all=file.exports??[];
    const [head,...tail]=symbol.split('.');
    let matching=all.filter(item=>item.exported===head && item.kind!=='star');
    if (!matching.length && file.language==='python' && !tail.length) {
      const ids=localTargets(file,symbol);
      if(ids.length) return {ids,reason:null,reexport:false};
      // Python module imports are exposed bindings, including package __init__ reexports.
      matching=(file.imports??[]).filter(item=>item.local===head).map(item=>({...item,exported:head,kind:'named'}));
    }
    let ids=[],reexport=false,reason=null;
    for (const item of matching) {
      if(item.typeOnly){reason='type_only_not_callable';continue;}
      if(file.language==='python' && moduleBindings(file,item.local??head).length>1){reason='ambiguous';continue;}
      if (item.source) {
        const found=modules(file,item.source);
        if(found.files.length!==1) {reason=found.reason;continue;}
        const imported=item.imported??item.local??head;
        const name=tail.length && imported==='*' ? tail.join('.') : tail.length ? imported+'.'+tail.join('.') : imported;
        if(name==='*'){reason='namespace_not_callable';continue;}
        const child=exported(found.files[0],name,next);
        ids.push(...child.ids); reexport=true; if(child.reason && child.reason!=='unresolved_export') reason??=child.reason;
      } else if (!tail.length) {
        const targets=localTargets(file,item.local??head,item.targetId);
        ids.push(...targets);
        if(!targets.length){
          const binding=localImport(file,item.local??head);
          if(binding && !binding.typeOnly && binding.imported!=='*'){
            const found=modules(file,binding.source);
            if(found.files.length!==1){reason??=found.reason;continue;}
            const child=exported(found.files[0],binding.imported??binding.local,next);
            ids.push(...child.ids);reexport=true;
            if(child.reason && child.reason!=='unresolved_export')reason??=child.reason;
          } else if(moduleBindings(file,item.local??head).length>1)reason='ambiguous';
        }
      }
    }
    if (!matching.length && !tail.length && head!=='default') {
      for (const item of all.filter(item=>item.kind==='star' && item.source)) {
        const found=modules(file,item.source);
        if(found.files.length!==1){reason??=found.reason;continue;}
        const child=exported(found.files[0],symbol,next);
        ids.push(...child.ids); reexport=true; if(child.reason && child.reason!=='unresolved_export') reason??=child.reason;
      }
    }
    return {ids:unique(ids),reexport,reason:reason??(ids.length?null:'unresolved_export')};
  }
  function importFor(node, call) {
    if (call.importBinding) return call.importBinding;
    const base=call.name?.split('.')[0];
    // Flat scopeBindings are nearest-first. A non-import nearest binding must stop lookup.
    const nearest=(node.scopeBindings??node.bindings??[]).find(binding=>binding.name===base);
    if (nearest?.source && (nearest.kind?.includes('import') || nearest.kind==='python' || nearest.imported!==undefined)) return nearest;
    return null;
  }
  for (const node of nodes) {
    const callers=fileMap.get(key(node.file))??[];
    if(callers.length!==1) continue;
    const caller=callers[0];
    for(const call of node.calls??[]) {
      if(call.targetId || call.shadowed || call.candidates?.length || ['ambiguous','candidate','dynamic','dynamic_import'].includes(call.status)) continue;
      const binding=importFor(node,call);
      if(!binding) continue;
      if(binding.typeOnly){call.relationReason='type_only_not_callable';continue;}
      const imported=binding.imported;
      if(imported==='*' && ['python_from','python'].includes(binding.kind) && binding.local==='*') continue;
      const found=modules(caller,binding.source);
      if(found.files.length!==1) {
        call.relationReason=found.reason;
        if(found.reason==='external_boundary') call.status='external_boundary';
        else if(found.reason==='ambiguous') call.status='ambiguous';
        continue;
      }
      const targetFile=found.files[0];
      const namespace=binding.kind==='namespace'||binding.kind==='python_import'||imported==='*';
      let symbol=imported??binding.local;
      if(namespace) {
        let prefix=binding.local;
        if(binding.kind==='python_import' && binding.local===binding.source.split('.')[0] && call.name.startsWith(binding.source+'.')) prefix=binding.source;
        if(!call.name.startsWith(prefix+'.')){call.relationReason='namespace_not_callable';continue;}
        symbol=call.name.slice(prefix.length+1);
      } else if(call.name!==binding.local) {
        if(caller.language!=='python'){call.relationReason='imported_object_member_unverified';continue;}
        // from package import module; module.fn is allowed only when that module is in scope.
        const suffix=call.name.startsWith(binding.local+'.')?call.name.slice(binding.local.length+1):null;
        if(!suffix)continue;
        const subsource=binding.source+(binding.source.endsWith('.')?'':'.')+symbol;
        const submodule=modules(caller,subsource);
        if(submodule.files.length!==1){call.relationReason=submodule.reason;continue;}
        const resolved=exported(submodule.files[0],suffix);
        const ids=unique(resolved.ids);
        if(ids.length===1 && !resolved.reason && (nodeMap.get(ids[0])??[]).length===1){call.targetId=ids[0];call.status=resolved.reexport?'confirmed_reexport':'confirmed_import';}
        else {call.relationReason=ids.length>1?'ambiguous':resolved.reason;if(ids.length>1)call.status='ambiguous';}
        continue;
      }
      const resolved=exported(targetFile,symbol);
      const ids=unique(resolved.ids);
      if(ids.length===1 && !resolved.reason && (nodeMap.get(ids[0])??[]).length===1) {
        call.targetId=ids[0];call.status=resolved.reexport?'confirmed_reexport':'confirmed_import';delete call.relationReason;
      } else {
        const ambiguous=ids.length>1 || ids.some(id=>(nodeMap.get(id)??[]).length>1);
        call.relationReason=ambiguous?'ambiguous':resolved.reason;
        if(ambiguous || resolved.reason==='ambiguous')call.status='ambiguous';
      }
    }
  }
  // Standard contracts require matching nearest lexical import evidence, never spelling alone.
  for(const node of nodes){
    if(node.language!=='python')continue;
    const caller=(fileMap.get(key(node.file))??[])[0];if(!caller)continue;
    for(const call of node.calls??[]){
      const binding=call.importBinding,base=call.name?.split('.')[0];
      const nearest=(node.scopeBindings??node.bindings??[]).find(item=>item.name===base);
      const verified=!!binding&&nearest?.kind==='import'&&nearest.status!=='candidate'&&nearest.status!=='ambiguous'&&!nearest.reassigned&&
        nearest.source===binding.source&&nearest.imported===binding.imported&&nearest.local===binding.local&&
        (nearest.importKind??nearest.kind)===binding.kind&&(nearest.level??0)===(binding.level??0)&&
        (call.bindingScope==null||nearest.scope===call.bindingScope)&&
        (binding.line===undefined||nearest.line===binding.line);
      if(!verified)continue;
      const core=binding.source.split('.')[0];
      // Explicit local-module collisions remain project references/unresolved, not stdlib contracts.
      const localCore=[root,path.dirname(caller.file)].some(directory=>{
        const moduleFile=path.join(directory,core+'.py'),packageDirectory=path.join(directory,core);
        return inRoot(root,moduleFile)&&fs.existsSync(moduleFile)||inRoot(root,packageDirectory)&&fs.existsSync(packageDirectory);
      });
      if(localCore)continue;
      const contract=getPythonModuleContract(call,{language:node.language,lexicalImportVerified:verified});
      if(!contract)continue;
      node.externalContracts??=[];
      if(!node.externalContracts.some(item=>item.name===contract.name&&(item.canonicalName??item.name)===contract.canonicalName&&item.source===contract.source))node.externalContracts.push(contract);
      call.contractStatus='verified_standard_library_contract';call.contractSource=contract.source;
    }
  }
  for(const node of nodes){
    if(node.language!=='python')continue;
    const caller=(fileMap.get(key(node.file))??[])[0];if(!caller)continue;
    const localPathlib=[root,path.dirname(caller.file)].some(directory=>fs.existsSync(path.join(directory,'pathlib.py'))||fs.existsSync(path.join(directory,'pathlib')));
    if(localPathlib||modules(caller,'pathlib').reason!=='external_boundary')continue;
    for(const call of node.calls??[]){
      const proof=call.declaredPathProvenance,imported=proof?.importBinding;if(!imported)continue;
      const nearest=(node.scopeBindings??node.bindings??[]).find(binding=>binding.name===imported.local);
      const verified=nearest?.kind==='import'&&nearest.status!=='candidate'&&nearest.status!=='ambiguous'&&nearest.source==='pathlib'&&nearest.imported==='Path'&&nearest.local===imported.local&&nearest.importKind==='python_from'&&(nearest.level??0)===0;
      const contract=getDeclaredPathContract(call,{stdlibImportVerified:verified});if(!contract)continue;
      node.externalContracts??=[];
      if(!node.externalContracts.some(item=>item.name===contract.name&&item.canonicalName===contract.canonicalName&&item.source===contract.source))node.externalContracts.push(contract);
      call.contractStatus='conditional_declared_path_contract';call.contractSource=contract.source;
    }
  }
  graph.relationPolicy='Explicit static imports and reexports within analyzed project files only; no automatic source discovery.';
  return graph;
}
