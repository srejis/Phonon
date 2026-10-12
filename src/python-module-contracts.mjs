/** Minimal observed stdlib call contracts; no module loading, file access or execution. */
const assumption='명시 import가 표준 Python 라이브러리를 가리키며 호출 지점의 가림·재할당이 배제되고 런타임 모듈/속성 monkey-patching이 없다는 가정. 실제 파일 내용·존재·권한·실행 성공이나 digest 값은 확정하지 않음.';
const records={
 'os.path.normcase':{input:'대소문자 표기를 정규화할 경로',process:'실행 플랫폼의 경로 대소문자 규칙을 적용: Windows에서는 소문자화와 슬래시를 역슬래시로 변환, 다른 운영체제에서는 변경하지 않음',output:'플랫폼 규칙을 적용한 경로 표기; 경로 존재나 파일 내용의 확인을 뜻하지 않음',source:'https://docs.python.org/3.14/library/os.path.html#os.path.normcase'},
 'os.replace':{input:'이름을 옮길 src와 dst 및 실제 지정된 디렉터리 descriptor',process:'src를 dst로 이름 변경하며 대상이 기존 파일이면 권한이 허용될 때 교체; 다른 파일시스템 등에서는 실패 가능',output:'성공하는 경우 파일시스템 이름 변경/교체 효과; 성공 여부를 정적으로 확정하지 않으며 성공한 이름 변경은 atomic 계약',source:'https://docs.python.org/3.14/library/os.html#os.replace'},
 'shutil.copy2':{input:'복사할 src와 dst 및 실제 지정된 follow_symlinks',process:'파일 내용을 복사하고 지원되는 메타데이터 보존을 시도; 모든 메타데이터 복제를 보장하지 않음',output:'성공하는 경우 복사된 대상 경로와 파일 복사 효과; 실제 내용·성공 여부는 확인되지 않음',source:'https://docs.python.org/3.14/library/shutil.html#shutil.copy2'},
 'hashlib.sha1':{input:'초기 데이터가 있으면 그 bytes-like 값과 실제 지정된 usedforsecurity',process:'SHA-1 해시 객체를 생성하고 제공된 초기 데이터를 반영',output:'SHA-1 해시 객체; hexdigest 문자열이나 실제 digest 값은 이 생성자 호출만으로 확정하지 않음',source:'https://docs.python.org/3.14/library/hashlib.html#hashlib.sha1'}
};
for(const value of Object.values(records))Object.freeze(value);
const contracts=Object.freeze(records);
export const supportedPythonModuleCalls=Object.freeze(Object.keys(contracts));
const identifier=/^[A-Za-z_]\w*$/;
const qualified=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function canonicalSymbol(call,binding){
 if(typeof call.name!=='string'||typeof binding.source!=='string'||typeof binding.local!=='string'||typeof binding.imported!=='string')return null;
 if(!qualified.test(call.name)||!qualified.test(binding.source)||!identifier.test(binding.local))return null;
 if(binding.kind==='python_import'){
  if(binding.imported!=='*')return null;
  // import os.path binds os; import os.path as osp binds osp instead.
  const unaliasedDotted=binding.source.includes('.')&&binding.local===binding.source.split('.')[0];
  const prefix=unaliasedDotted?binding.source:binding.local;
  if(!call.name.startsWith(prefix+'.'))return null;
  return binding.source+call.name.slice(prefix.length);
 }
 if(binding.kind==='python_from'){
  if(!identifier.test(binding.imported)||binding.imported==='*')return null;
  if(call.name===binding.local)return binding.source+'.'+binding.imported;
  if(call.name.startsWith(binding.local+'.'))return binding.source+'.'+binding.imported+call.name.slice(binding.local.length);
 }
 return null;
}

/** Positive proof must come from the parser's nearest lexical import binding at this call. */
export function getPythonModuleContract(call,{language,lexicalImportVerified=false}={}){
 if(language!=='python'||lexicalImportVerified!==true||!call||typeof call!=='object'||Array.isArray(call))return null;
 if(call.targetId!=null||call.status!=='external_boundary'||call.shadowed!==false||call.reassigned||call.candidates?.length)return null;
 if(call.relationReason!==undefined&&call.relationReason!=='external_boundary')return null;
 const binding=call.importBinding;
 if(!binding||typeof binding!=='object'||Array.isArray(binding)||binding.level>0||binding.reassigned||binding.typeOnly||['candidate','ambiguous'].includes(binding.status))return null;
 const canonicalName=canonicalSymbol(call,binding);
 if(!canonicalName||!Object.hasOwn(contracts,canonicalName))return null;
 // Preserve the actual call spelling so externalContracts can match alias call sites.
 const returns={'os.path.normcase':['정규화된 경로 표기'],'os.replace':[],'shutil.copy2':['복사된 대상 경로'],'hashlib.sha1':['SHA-1 해시 객체']};
 const effects={'os.path.normcase':[],'os.replace':['src에서 dst로 파일 이름 변경/교체 요청'],'shutil.copy2':['파일 내용 복사 및 지원되는 메타데이터 보존 시도'],'hashlib.sha1':[]};
 return {name:call.name,canonicalName,...contracts[canonicalName],returns:returns[canonicalName],effects:effects[canonicalName],assumption};
}

