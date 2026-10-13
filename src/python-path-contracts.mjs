/** Conditional contracts for observed, explicitly declared standard Path parameters. No I/O. */
const key=n=>`${n?.type}:${n?.startIndex}:${n?.endIndex}`;
const stop=new Set(['function_definition','class_definition','lambda']);
const identifier=/^[A-Za-z_]\w*$/;
const assumption='조건부 선언 계약: pathlib와 Path 속성의 런타임 교체가 없고 실제 인자가 명시된 표준 Path 계약을 충족한다고 가정. 타입 주석은 런타임 강제나 실제 값/파일 존재/내용/작업 성공을 증명하지 않음.';
const docs='https://docs.python.org/3.14/library/pathlib.html#';
const contracts={
 read_bytes:{input:'receiver 경로와 해당 파일의 기존 바이너리 내용',process:'경로가 가리키는 파일의 바이너리 내용 읽기 요청',returns:['파일의 바이너리 내용을 담은 bytes'],effects:['파일 내용 읽기 요청'],output:'성공하는 경우 파일 내용의 bytes; 실제 내용/읽기 성공은 미확인',source:docs+'pathlib.Path.read_bytes'},
 mkdir:{input:'receiver 경로와 실제 mode/parents/exist_ok 인자',process:'디렉터리 생성 요청; parents=True면 누락된 상위 디렉터리도 생성하며 exist_ok는 기존 디렉터리의 허용 조건',returns:[],effects:['receiver 위치의 디렉터리 생성 요청'],output:'성공하는 경우 디렉터리 생성 효과; 실제 성공/존재는 미확인',source:docs+'pathlib.Path.mkdir'},
 with_suffix:{input:'receiver 경로와 지정한 새 suffix',process:'suffix를 바꾼 새 경로를 계산; 빈 suffix는 기존 suffix 제거',returns:['suffix를 바꾼 새 Path'],effects:[],output:'새 Path 값; 파일 생성이나 이름 변경 실행을 뜻하지 않음',source:docs+'pathlib.PurePath.with_suffix'},
 unlink:{input:'receiver 파일/심볼릭링크 경로와 실제 missing_ok',process:'파일 또는 심볼릭링크 삭제 요청; 기본 missing_ok=False는 누락 시 FileNotFoundError',returns:[],effects:['receiver 파일/심볼릭링크 삭제 요청'],output:'성공하는 경우 삭제 효과; 실제 파일 존재/삭제 성공은 미확인',source:docs+'pathlib.Path.unlink'},
 open:{input:'receiver 경로와 실제 mode/buffering/encoding/errors/newline',process:'해당 mode로 파일 열기 요청; 기본 mode는 r이며 쓰기 mode의 생성/절단 조건은 실제 지정값에 따름',returns:['열린 파일 객체'],effects:['실제 mode에 따른 파일 열기 요청'],output:'성공하는 경우 파일 객체와 mode에 따른 파일 열기 효과; 내용이나 성공은 미확인',source:docs+'pathlib.Path.open'},
 is_file:{input:'receiver 경로와 실제 follow_symlinks',process:'일반 파일 여부 조회 요청',returns:['일반 파일 여부 bool'],effects:['파일 종류 조회 요청'],output:'일반 파일 여부 판정값; 실제 결과는 실행 전 확정하지 않음',source:docs+'pathlib.Path.is_file'},
 resolve:{input:'receiver 경로와 실제 strict',process:'심볼릭링크 등을 해소한 절대 경로 계산 요청; strict 조건에 따라 실패 처리',returns:['해소한 Path'],effects:['경로 해소 조회 요청'],output:'해소한 Path; 기본 비엄격 모드는 실제 경로 존재를 보장하지 않음',source:docs+'pathlib.Path.resolve'}
};
export function callResultUse(ast){
 let value=ast,parent=ast?.parent;
 while(parent?.type==='parenthesized_expression'){value=parent;parent=parent.parent;}
 if(parent?.type==='expression_statement'&&key(parent.namedChildren[0])===key(value))return 'ignored';
 if(parent?.type==='return_statement'&&key(parent.namedChildren[0])===key(value))return 'direct_return';
 if(['raise_statement','throw_statement'].includes(parent?.type)&&key(parent.namedChildren[0])===key(value))return 'raised';
 return 'local_use';
}

export function declaredPathReceiverProof(definition,receiver,useAt,{resolveAt}){
 const parameters=new Map(),assignments=new Map(),deleted=new Set(),mutatedMethodRoots=new Set();
 for(const parameter of definition.childForFieldName('parameters')?.namedChildren??[]){
  if(!['typed_parameter','typed_default_parameter'].includes(parameter.type))continue;
  const name=parameter.childForFieldName('name')?.text??parameter.namedChildren.find(n=>n.type==='identifier')?.text;
  const annotation=parameter.childForFieldName('type')?.text?.trim();
  if(!identifier.test(name??'')||!identifier.test(annotation??''))continue;
  const result=resolveAt(parameter,annotation),binding=result?.binding;
  if(result?.status==='candidate'||binding?.kind!=='import'||binding.source!=='pathlib'||binding.imported!=='Path'||binding.local!==annotation||binding.importKind!=='python_from'||(binding.level??0)!==0)continue;
  const ownParameter=resolveAt(parameter,name)?.binding;
  if(ownParameter?.kind!=='parameter')continue;
  parameters.set(name,{parameter:name,parameterScope:ownParameter.scope,annotation,importBinding:{source:binding.source,imported:binding.imported,local:binding.local,kind:binding.importKind,level:0}});
 }
 function visit(n){if(n!==definition&&stop.has(n.type))return;
  const attributeMutation=target=>{
   if(target?.type!=='attribute'||!Object.hasOwn(contracts,target.childForFieldName('attribute')?.text??''))return;
   const object=target.childForFieldName('object');if(object?.type==='identifier')mutatedMethodRoots.add(object.text);
  };
  if(['assignment','augmented_assignment'].includes(n.type))attributeMutation(n.childForFieldName('left'));
  if(n.type==='delete_statement')for(const target of n.namedChildren){attributeMutation(target);if(['tuple','list','expression_list'].includes(target.type))for(const item of target.namedChildren)attributeMutation(item);}

  if(n.type==='delete_statement'){const names=part=>{if(part.type==='identifier')deleted.add(part.text);else if(['tuple','list','expression_list'].includes(part.type))for(const child of part.namedChildren)names(child);};for(const child of n.namedChildren)names(child);}
  if(n.type==='assignment'&&n.childForFieldName('left')?.type==='identifier'){
   const name=n.childForFieldName('left').text,items=assignments.get(name)??[];items.push(n);assignments.set(name,items);
  }
  for(const child of n.namedChildren)visit(child);
 }visit(definition);
 const active=new Set();
 function prove(expression,at){
  if(!expression)return null;
  if(expression.type==='identifier'){
   const name=expression.text,resolved=resolveAt(at,name),binding=resolved?.binding;
   if(deleted.has(name)||mutatedMethodRoots.has(name))return null;
   if(resolved?.status==='candidate'||!binding)return null;
   const parameter=parameters.get(name);
   if(parameter&&binding.kind==='parameter'){
    if(mutatedMethodRoots.has(parameter.annotation))return null;
    const annotationBinding=resolveAt(at,parameter.annotation);
    const imported=annotationBinding?.binding;
    if(annotationBinding?.status==='candidate'||imported?.kind!=='import'||imported.source!=='pathlib'||imported.imported!=='Path'||imported.local!==parameter.annotation||imported.importKind!=='python_from')return null;
    if(binding.scope!==parameter.parameterScope)return null;
    return {...parameter,derivations:[]};
   }
   const candidates=assignments.get(name)??[];
   if(binding.kind!=='assignment'||candidates.length!==1||active.has(name))return null;
   const assignment=candidates[0],right=assignment.childForFieldName('right');
   // Only an unconditional direct body assignment can establish the observed alias.
   const statement=assignment.parent?.type==='expression_statement'?assignment.parent:assignment;
   if(key(statement.parent)!==key(definition.childForFieldName('body')))return null;
   if(at.startIndex<=assignment.endIndex||binding.line!==assignment.startPosition.row+1||right?.type!=='call'||right.childForFieldName('function')?.childForFieldName('attribute')?.text!=='with_suffix')return null;
   active.add(name);const proof=prove(right,right);active.delete(name);
   return proof?{...proof,derivations:[...proof.derivations,{kind:'unique_with_suffix_assignment',name}]}:null;
  }
  if(expression.type==='attribute'&&expression.childForFieldName('attribute')?.text==='parent'){
   const proof=prove(expression.childForFieldName('object'),at);return proof?{...proof,derivations:[...proof.derivations,{kind:'parent'}]}:null;
  }
  if(expression.type==='call'){
   const fn=expression.childForFieldName('function');
   if(fn?.type!=='attribute'||fn.childForFieldName('attribute')?.text!=='with_suffix')return null;
   const proof=prove(fn.childForFieldName('object'),expression);return proof?{...proof,derivations:[...proof.derivations,{kind:'with_suffix'}]}:null;
  }
  return null;
 }
 const proof=prove(receiver,useAt);
 return proof?{kind:'declared_parameter_path',...proof,receiver:receiver.text,conditional:true}:null;
}

export function getDeclaredPathContract(call,{stdlibImportVerified=false}={}){
 const proof=call?.declaredPathProvenance,method=call?.declaredPathMethod;
 if(stdlibImportVerified!==true||call.targetId||call.status==='candidate'||call.status==='ambiguous'||proof?.kind!=='declared_parameter_path'||!Object.hasOwn(contracts,method??''))return null;
 const contract=contracts[method];
 return {name:call.name,canonicalName:'pathlib.Path.'+method,...contract,returns:[...contract.returns],effects:[...contract.effects],assumption};
}
