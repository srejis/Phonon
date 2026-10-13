/** Source/binding attention only: no new relationships, values or runtime types. */
const escapeRegex = value => Array.from(String(value)).map(ch => '.+*?^$()[]{}|'.includes(ch) || ch.charCodeAt(0) === 92 ? String.fromCharCode(92) + ch : ch).join('');
const list = value => Array.isArray(value) ? value : [];
const printable = value => value == null ? '' : String(value);
const pythonEvidenceCode = source => printable(source).replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[^\r\n]*/g, token => token.replace(/[^\r\n]/g, ' '));
export const pythonModuleStateReads = node => {
  if (node.language !== 'python') return [];
  const localNames = new Set(list(node.bindings).filter(binding => binding.scope !== '<module>').map(binding => binding.name));
  const candidates = list(node.scopeBindings).filter(binding => binding.kind === 'assignment' && binding.scope === '<module>' && !binding.targetId && typeof binding.name === 'string' && /^[A-Za-z_]\w*$/.test(binding.name) && !localNames.has(binding.name) && !list(node.scopeBindings).some(other => other.name === binding.name && (other.scope !== '<module>' || other.kind !== 'assignment' || other.targetId)));
  if (!candidates.length) return [];
  const rawLines = printable(node.source).split(/\r?\n/);
  const lines = pythonEvidenceCode(node.source).split(/\r?\n/), found = new Map();
  let rootSeen = false, header = false, nestedIndent = null;
  for (const [index, content] of lines.entries()) {
    let line = content;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g,'        ').length;
    if (nestedIndent !== null) {if (indent > nestedIndent) continue; nestedIndent = null;}
    if (/^(?:async\s+)?def\s|^class\s/.test(trimmed)) {
      if (!rootSeen && (!node.kind || node.kind === 'function_definition') && /^(?:async\s+)?def\s/.test(trimmed)) {rootSeen = true; header = !/:\s*$/.test(trimmed);}
      else nestedIndent = indent;
      continue;
    }
    if (header) {if (/:\s*$/.test(trimmed)) header = false; continue;}
    if (/^(?:from\s|import\s|global\s|nonlocal\s|del\s)/.test(trimmed)) continue;
    // Annotation-only names are not runtime state reads; retain a typed assignment's RHS.
    if (/^\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*:/.test(line)) {
      const assignment = line.match(/(?<![=!<>])=(?!=)/);
      if (!assignment) continue;
      line = line.slice(assignment.index + 1);
    }
    for (const binding of candidates) {
      const names = new RegExp('\\b'+escapeRegex(binding.name)+'\\b','g');
      let occurrence;
      while ((occurrence = names.exec(line))) {
        const before = line.slice(0,occurrence.index),after = line.slice(names.lastIndex);
        if (/\.\s*$/.test(before) || /^\s*(?:=(?!=)|\()/.test(after)) continue;
        if (!found.has(binding.name)) found.set(binding.name,{name:binding.name,kind:binding.kind,scope:binding.scope,readSites:[]});
        const entry = found.get(binding.name), readLine = (node.startLine ?? 1) + index;
        if (!entry.readSites.some(site=>site.line===readLine)) entry.readSites.push({line:readLine,text:rawLines[index].trim()});
      }
    }
  }
  return [...found.values()];
};


function pythonOwnedBody(source){
 const kept=[],lines=pythonEvidenceCode(source).split(/\r?\n/);let root=false,nested=null,header=false;
 for(const content of lines){const trimmed=content.trim();if(!trimmed)continue;const indent=content.match(/^[ \t]*/)[0].replace(/\t/g,'        ').length;
  if(nested!==null){if(indent>nested)continue;nested=null;}
  if(/^(?:async\s+)?def\s|^class\s/.test(trimmed)){if(!root&&/^(?:async\s+)?def\s/.test(trimmed)){root=true;header=!/:\s*$/.test(trimmed);}else nested=indent;continue;}
  if(header){if(/:\s*$/.test(trimmed))header=false;continue;}
  if(/^(?:from\s|import\s|global\s|nonlocal\s|del\s)/.test(trimmed))continue;
  let line=content;
  if(/^\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*:/.test(line)){const assignment=line.match(/(?<![=!<>])=(?!=)/);if(!assignment)continue;line=line.slice(assignment.index+1);}
  kept.push(line);
 }return kept.join('\n');
}

export function pythonInputRoleHints(node,children=[],group=false){
 if(node.language!=='python')return {};
 const result={},contracts=list(node.externalContracts),calls=list(node.calls);
 const hasIteration=list(node.facts).some(f=>f.kind==='for_statement');
 const queryUses=calls.flatMap(call=>{const contractIndex=contracts.findIndex(c=>c.name===call.name&&(c.canonicalName==='pathlib.Path.read_bytes'&&['local_use','direct_return'].includes(call.resultUse)||c.canonicalName==='pathlib.Path.is_file'&&hasIteration&&call.resultUse==='local_use'));return contractIndex>=0?[{name:call.name,line:call.line,contractIndex}]:[];});
 if(queryUses.length)result.resourceQueryUses=queryUses;
 const childById=new Map(list(children).map(c=>[c.id,c]));
 const receiverChildInputs=calls.flatMap(call=>{
  const receiver=call.name?.match(/^([A-Za-z_]\w*)\./)?.[1],child=childById.get(call.targetId);
  if(!receiver||!child)return [];
  const inputIndices=list(child.input).flatMap((text,index)=>new RegExp('\\b'+escapeRegex(receiver)+'\\.[A-Za-z_]\\w*').test(text)?[index]:[]);
  return inputIndices.length?[{childId:child.id,name:call.name,line:call.line,receiver,inputIndices}]:[];
 });
 if(receiverChildInputs.length)result.receiverChildInputs=receiverChildInputs;
 if(!group)return result;
 const moduleStateReads=pythonModuleStateReads(node);if(moduleStateReads.length)result.moduleStateReads=moduleStateReads;
 const locals=new Set(list(node.bindings).map(b=>b.name)),body=pythonOwnedBody(node.source);
 const readsName=name=>body.split('\n').some(line=>{const pattern=new RegExp('\\b'+escapeRegex(name)+'\\b','g');let match;while((match=pattern.exec(line))){const before=line.slice(0,match.index),after=line.slice(pattern.lastIndex);if(!/\.\s*$/.test(before)&&!/^\s*(?:=(?!=)|:)/.test(after))return true;}return false;});
 const capturedInputs=list(node.scopeBindings).filter(b=>b.scope!=='<module>'&&b.targetId!==node.id&&!locals.has(b.name)&&['parameter','function','assignment'].includes(b.kind)&&readsName(b.name)).map(({name,kind,scope,targetId})=>({name,kind,scope,...(targetId?{targetId}:{})}));
 if(capturedInputs.length)result.capturedInputs=capturedInputs;
 const localAssignments=list(node.bindings).filter(b=>b.kind==='assignment').map(({name,scope})=>({name,scope}));
 if(localAssignments.length)result.localAssignments=localAssignments;
 return result;
}

export const pythonInputRoleInstructions="Python evidenced input roles:\nresourceQueryUses points to an existing conditional query contract. INPUT must distinguish an address\nfrom the pre-existing resource information queried for an actual branch/iteration. Keep unverified\niteration/query expressions and uncertainty; do not guarantee file existence, enumeration policy,\nreturned contents or success. receiverChildInputs points to the completed child's INPUT entries:\npreserve receiver state supplied THROUGH that confirmed child as caller INPUT by its information\nrole, not as a fabricated direct field read. No initial/current value, runtime type, new reference\nor child slicing/decoding algorithm is inferred. A local assignment of a child result remains PROCESS,\nnot a new external input. Uncertain external implementation does not erase evidenced input roles.";
export const groupInputRoleInstructions="Python group input/observable ownership:\nmoduleStateReads uses the same source/binding computation as normal nodes. Preserve these module\ninformation roles in INPUT. capturedInputs are existing outer-scope bindings actually used, not\nnew fields or values; explain captured receiver/callable roles. localAssignments are current-owned\nintermediates even when assigned from a child; do not turn them into external INPUT.\nFor each actual external child use, retain the child's supplied observable shared-state EFFECT role\nin caller OUTPUT without copying its guards, formulas or construction algorithm. Child return use\nand observable effect are separate: ignored return does not discard an effect, and no explicit\nreturn does not imply empty OUTPUT. Preserve the child's conditional/unknown effect limitations;\nnever guarantee state mutation succeeded or invent effects from a callable's name.";
