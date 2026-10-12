/** Observed Python builtin contracts only. Pure metadata; no execution or environment access. */
const assumption='표준 Python builtins이며 런타임 monkey-patching이나 __builtins__ 교체가 없다는 가정. 어휘 바인딩 가림은 호출 지점에서 배제됨. 사용자 정의 프로토콜 메서드의 내부·실행 성공·실제 값은 이 계약으로 확정하지 않음.';
const functions='https://docs.python.org/3/library/functions.html#';
const records={
 str:{name:'str',input:'문자열 표현을 얻을 객체; 실제 호출에 지정된 encoding/errors',process:'일반 객체는 문자열 표현을 구하고, encoding/errors가 지정된 bytes-like 입력은 해당 디코딩 계약을 사용',output:'변환된 문자열; 인자가 없으면 빈 문자열',source:'https://docs.python.org/3/library/stdtypes.html#str'},
 int:{name:'int',input:'정수로 변환할 수나 문자열과 실제 지정한 base',process:'숫자를 정수로 변환하며 실수는 0 방향으로 절단; 문자열은 지정 진법으로 해석하고 기본 base는 10',output:'변환된 정수; 부적합한 입력의 변환 실패 가능',source:functions+'int'},
 isinstance:{name:'isinstance',input:'검사할 객체와 classinfo',process:'객체가 주어진 타입 또는 하위 타입의 인스턴스인지 검사; 허용된 타입 집합이면 그 중 하나와의 일치를 검사',output:'판정 bool; 잘못된 classinfo는 TypeError 가능',source:functions+'isinstance'},
 next:{name:'next',input:'iterator와 실제로 지정된 default',process:'iterator의 다음 항목을 요청하여 소비하고, 소진 시 지정된 default를 사용',output:'다음 항목 또는 소진 시 default; default가 없으면 StopIteration',source:functions+'next'},
 any:{name:'any',input:'원소의 참/거짓을 검사할 iterable',process:'참인 원소를 찾는 즉시 True로 종료하고 그때까지 iterable을 소비',output:'하나라도 참이면 True, 모두 거짓이거나 비어 있으면 False',source:functions+'any'},
 max:{name:'max',input:'하나의 iterable 또는 둘 이상의 비교 대상; 실제 지정된 key/default',process:'기본 비교 또는 key 결과에 따라 가장 큰 항목 선택; 최댓값이 동률이면 먼저 나타난 항목 선택',output:'선택된 원래 항목; 빈 iterable이면 지정 default, 없으면 ValueError',source:functions+'max'},
 ValueError:{name:'ValueError',input:'예외 생성자에 전달하는 메시지 등 인자',process:'주어진 인자를 보관하는 ValueError 예외 객체 생성; 생성 자체와 raise 문에 의한 예외 발생은 구별',output:'ValueError 객체; 실제 예외 발생은 호출 바깥의 raise 문 근거가 필요',source:'https://docs.python.org/3/library/exceptions.html#ValueError'}
};
for(const value of Object.values(records))Object.freeze(value);
const contracts=Object.freeze(records);
export const supportedPythonBuiltins=Object.freeze(Object.keys(contracts));

/** lexicalUnshadowed=true must come from the parser's lexical resolution at THIS call. */
export function getPythonBuiltinContract(call,{language,lexicalUnshadowed=false}={}) {
 if(language!=='python'||lexicalUnshadowed!==true||!call||typeof call!=='object'||Array.isArray(call))return null;
 if(typeof call.name!=='string'||!Object.hasOwn(contracts,call.name))return null;
 if(call.targetId||call.shadowed||call.importBinding||call.candidates?.length||call.bindingScope!=null)return null;
 if(['candidate','ambiguous','dynamic','dynamic_import'].includes(call.status))return null;
 return {...contracts[call.name],returns:[contracts[call.name].output],effects:['next','any'].includes(call.name)?['iterable/iterator 항목 소비 요청']:[],assumption};
}
