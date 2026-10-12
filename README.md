# Phonon / 포논

코드를 원본 근거와 연결된 한국어 입력·처리·출력 설명으로 바꾸는 로컬 실험 도구입니다. 하위 의미를 먼저 확보하고 상위의 직접 처리와 하위 내부를 구분합니다.

**상태: 초기 구현과 소규모 검증. 최종 의미화 재검증은 SDK `ModelBehaviorError`로 중단되었습니다. 전체 지원 완료가 아닙니다.** 생성 성공은 설명 정확성 판정과 구분하며 결과는 검수 대상으로 표시합니다.

## 실행

현재 검증 환경은 Windows, Node.js 22.22.0이며 승인된 원본 범위는 `D:\project`입니다. 프로젝트는 Phonon과 다른 위치에 유지됩니다. 분석 데이터는 Phonon의 `.local`에만 저장합니다.

```powershell
npm ci --cache .npm-cache --ignore-scripts
npm test
node cli.mjs register "내 프로젝트" "D:\project\my-project"
node cli.mjs projects
node cli.mjs status <project-id>
node cli.mjs analyze <project-id> 0 sample.py
npm run ui
```

검수 화면은 `http://127.0.0.1:4317`입니다. `analyze`의 숫자는 신규 모델 호출 상한입니다. 기본 0은 유료 호출을 허용하지 않습니다. 유효한 캐시만 재사용하며 예산 부족·분석 실패 시 기존 정상 결과를 보존합니다. UI, CLI, MCP는 같은 엔진을 사용합니다.

## 모델과 중단 정책

- 제품 의미화는 OpenAI Agents SDK 0.20.0과 `gpt-6-luna`만 사용합니다.
- Phonon 루트 `.env`의 `OPENAI_API_KEY` 하나만 명시적으로 읽습니다. `.env.example`은 빈 예시입니다.
- 기본 입력 한도 3000, 출력 한도 1000, 요청당 호출 상한 24입니다. 입력 토큰은 전송 전에 추정하고 실제 사용량을 따로 기록합니다.
- 자동 재시도와 외부 추적을 끕니다. SDK/인증/호출 오류 후 `.local/api-stop.json`을 기록해 이후 유료 요청도 막습니다.
- 현재 실행에서 SDK 오류가 발생하여 이 중단 상태가 활성화되어 있습니다. 원인 세부는 확정되지 않았습니다. 키·모델 대체는 없습니다.
- 사용자가 원인 확인과 제한된 재개를 **명시적으로 승인한 후에만** 아래 명령을 사용합니다. 이 명령을 테스트 편의를 위해 자동 실행하지 않습니다.

```powershell
node cli.mjs resume-api --confirmed-by-user
```

코드/설명은 의미화 요청에서 외부 API로 전송됩니다. 완전 오프라인 도구가 아닙니다. 환경파일·비밀·실제 고객 데이터의 전송은 허용되지 않으며 선택 범위의 비밀 패턴 검사를 수행합니다.

## MCP

```powershell
node src/mcp.mjs
```

stdio MCP의 `list_projects`, `register_project`, `analysis_status`, `request_analysis`, `get_node`를 제공합니다. 모델 호출 예산을 생략하면 0입니다. 요청은 `running`과 작업 ID를 즉시 반환하고 상태 도구로 완료·실패를 확인합니다. 실제 SDK client와 stdio 연결은 검증했으며 사용자의 외부 AI 호스트 연결은 미확인입니다.

## 구현과 검증 범위

- Stage 1: Tree-sitter로 Python·TypeScript/JavaScript·TSX/JSX·HTML·CSS, 별도 PostgreSQL 문법 파서로 SQL을 분석합니다.
- Stage 2: 동일 파일의 확인 가능한 함수·중첩 함수·`self` 호출을 연결합니다. 매개변수/일부 할당의 이름 가림을 구분합니다. Python `print`는 로컬 재정의가 없는 경우 표준 기본 함수 계약을 전달합니다.
- Stage 3: H3 설명 소유 범위 전략에 H2의 사용 기반 입력 설명을 조합했습니다. 원본과 하위 의미·버전을 기록하고 근거 위치를 원본 줄로 환산합니다.
- 프로젝트별 의미화 입력·모델·프롬프트 조건으로 캐시를 분리합니다. 줄만 이동하면 결과를 재사용하며 하위 의미 변화가 실제 상위 요청을 바꿀 때 갱신합니다.
- 무료 회귀 검사 28개 통과. 앞서 중첩 함수 오연결, HTML 형제 누락, CSS 식별자 충돌, export 실행 누락을 재현하고 수정했습니다.
- 실제 Luna로 세 가설을 같은 작은 원본에서 비교하고 통합 전략으로 조건부 계층·변경 재분석·줄 이동·실패 보존을 검증했습니다. 8개 언어/문법 각각 작은 의미화 사례를 실행했습니다.
- **남은 관측 문제:** 하위 역할의 모호함을 고치면 하위 판별 기준을 표현만 바꿔 반복하는 결과가 나왔습니다. `else`를 코드에 없는 보수 비교식으로 바꾼 결과, CSS `output` 누락도 관측했습니다. 최종 H3 v6 보완의 상위·CSS 재검증은 SDK 오류로 미완료입니다.

현재 한계는 파일 간 import/export 연결, 언어 간 연결, 동적 디스패치, 순환 그룹 의미화, 큰 프로젝트 검증입니다. 64파일/100노드의 초기 제한을 초과하면 범위를 좁혀야 합니다. HTML은 루트 구조, CSS는 규칙, SQL은 파싱된 파일 단위를 사용합니다. 이동/이름 변경 동일성, 전체 언어 패턴, 설치 패키징과 외부 AI 호스트 연결은 미검증입니다.

## 실험 재현

`experiments/h1.mjs`, `h2.mjs`, `h3.mjs`는 독립 요청 구성입니다. `experiments/compare.mjs`는 검토된 작은 Python 원본 경로를 인자로 받습니다. `test/engine-real.mjs`는 검토된 실제 프로젝트 경로와 파일명을 받는 유료 통합 검사이며 기본 무료 검사에 포함하지 않습니다. 중단 상태에서 새 호출을 실행하지 않습니다.

공개 저장소에는 구현·프롬프트·자체 작성 회귀 사례·실행 문서만 둡니다. API 키, 분석 대상 원본, 생성된 실제 설명, 캐시·사용량 로그·API 응답은 `.local` 등 제외 경로에 보존합니다. 세 가설의 선택·실패 맥락은 [실험 기록](docs/experiment-notes.md)을 참조합니다.