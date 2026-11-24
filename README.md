# Review-Coding

Python 코드의 역할, 실행 효과와 연결을 원본에 대응시켜 검수합니다. Python이 스냅샷,
분석 단위, 모델 요청, 도구 실행, 결과 검증과 저장을 제어합니다. React 검수 화면은
로컬 HTTP API와 SSE로 연결됩니다.

## Windows 데스크톱 실행

설치가 완료된 프로젝트 폴더에서 npm run desktop으로 실행합니다.
로컬 .venv가 있으면 자동으로 사용하며, REVIEW_CODING_PYTHON으로 다른 Python을 지정할 수 있습니다.

Python 3.12, Node.js 22 이상, Windows 자격 증명 관리자가 필요합니다. 저장소 루트에서
PowerShell을 열고 다음 명령을 실행합니다.

~~~powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:REVIEW_CODING_PYTHON = (Resolve-Path '.venv/Scripts/python.exe').Path
Set-Location ui
npm ci
npm run desktop
~~~

메인 창은 현재 스냅샷과 분석 프로필의 유효한 완료 의미를 보여주는 원근 투영 3D 그래프입니다.
완료가 없으면 완료·부분 제출 수가 표시됩니다. 부분 결과는 검색의 **부분 결과** 또는 검수 창에서
열 수 있습니다. 좌표는 프로젝트·스냅샷·프로필·알고리즘 버전별로 저장됩니다. 새 연결은 보이는
위치에서 출발해 Worker가 주변만 보정합니다. 시점 초기화는 카메라만 전체 보기로 맞춥니다.

드래그로 회전하고
Shift+드래그 또는 오른쪽 버튼으로 이동하며 휠로 확대합니다. 왼쪽 파일이나 폴더를 선택하면
해당 단위 전체를 강조하고 카메라를 선택 범위에 맞춥니다. Ctrl+클릭은 개별 노드를
추가하거나 해제합니다. 빈 공간을 누르면 선택을 해제합니다. 더블클릭 또는 선택된
노드에서 Enter를 누르면 독립 의미 창이 열립니다.

**분석 시작**은 메인 창에서 실행합니다. **분석 진행**에서 현재 단계, 제출·남은 단위 수,
중단과 재개를 확인합니다. 진행 창을 닫아도 분석은 계속 실행됩니다. **설정**의 일반 탭에서
ChatGPT 계정과 탐색기 줄 간격을 관리하고, 모델 탭에서 모델과 추론 노력을 저장합니다.
**테마** 탭에서 Precision, Editorial(기본), Spatial을 미리 보고 저장할 수 있습니다.
저장하면 열린 모든 창에 적용되며, 브라우저는 같은 주소의 탭 사이에서 테마를 공유합니다.
기본값은 Luna와 medium이며, 저장된 값은 메인·검수·상세에서 실행하는 분석에 공통 적용됩니다.
OAuth 승인은 시스템 브라우저에서 진행합니다. 상단의 ⋯ 메뉴에서 Trace, 내보내기, 피드백과
품질 검증을 사용합니다. Python은 실제 소스 조각을 구독을 승인한 계정의 공식 Responses API에
전송합니다.

Electron이 전용 루프백 포트에서 Python 서비스를 시작합니다. 메인 창을 닫으면 이 앱의
독립 창과 자체 구동한 Python 서비스가 함께 종료됩니다. 기존 데이터 경로가 기본값이며
필요하면 REVIEW_CODING_DATA 환경 변수로 별도 데이터 폴더를 지정합니다. 브라우저에서도
main.py review로 같은 UI와 관리 화면에 접근할 수 있습니다.

## Windows 배포용 폴더 빌드

ui 폴더에서 npm run package:win을 실행합니다. 출력은 ui/release 아래 Electron 실행
폴더에 저장됩니다. Python과 requirements.txt 의존성은 실행할 PC에서 설치한 뒤
REVIEW_CODING_PYTHON을 지정합니다. 패키지에는 Python 실행 환경과 개인 분석·인증 데이터가
포함되지 않습니다.

Windows GUI 회귀 검증은 기존 check_cases 분석이 있는 REVIEW_CODING_DATA를 지정하고
ui 폴더에서 npm run test:desktop을 실행합니다. 좌표 재실행 및 손상 복구 테스트는
check_cases와 완료된 rembg 결과가 있는 폐기 가능한 DB 복사본에서
REVIEW_CODING_TEST_LAYOUT=isolated를 추가로 지정합니다.
순수 배치 테스트는 ui 폴더에서 node --test electron/layout.test.mjs로 실행합니다.

## CLI

브라우저 화면에서 연결한 동일한 데이터 경로를 사용합니다.

~~~powershell
.\.venv\Scripts\python.exe -B main.py status
.\.venv\Scripts\python.exe -B main.py register .\check_cases
.\.venv\Scripts\python.exe -B main.py analyze SNAPSHOT --limit 2
.\.venv\Scripts\python.exe -B main.py export SNAPSHOT
.\.venv\Scripts\python.exe -B -m unittest discover -v
~~~

자기 분석은 동일한 절차로 register . 을 실행합니다. --unit으로 특정 단위만 선택할 수
있습니다. 전체 배치는 기본 12개 단위·300초로 실행하고, 같은 스냅샷·모델·추론·프롬프트
프로필에서 완료된 단위는 재개 시 건너뜁니다.

## 기존 데이터와 검수 범위

Windows 기본 데이터는 %LOCALAPPDATA%/PythonCodeReview/review.sqlite3에 저장됩니다.
v1과 동일한 테이블을 읽어 기존 스냅샷·분석·피드백을 프로필 선택창에 표시합니다.
v2의 실행 프로필은 별도로 기록합니다. v1에서 사용한 Codex 로그인은 v2에 승계되지
않으므로 최초 1회 공식 ChatGPT 로그인과 구독 사용 승인이 필요합니다.
별도 데이터 디렉터리는 main.py --data PATH review처럼 명령 앞에 지정합니다.

도구는 고정된 스냅샷을 조회하고 제출한 구문 ID와 원본 위치를 검증합니다. UI의
'근거 포함 · 모델 확정'은 모델이 해당 관계를 확정으로 제출했다는 뜻입니다.
구문 대응 수치는 검수자가 판정하는 의미 정확도와 별도로 표시합니다.
백엔드는 분석 대상 Python 파일을 실행하거나 수정하지 않습니다.

공식 연동 문서: [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) ·
[모델 조회와 Responses 스트리밍](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

## 의존성 기반 분석

연결 조사와 의미화는 별도의 모델 실행입니다. 연결 조사가 확인한 로컬 선행 의존성
중 아직 의미가 없는 단위로 내려갑니다. 하위 결과가 준비되면 그 버전을 기록하고 상위
의미화를 재개합니다. 연결·의존성·진행 상태는 SQLite에 별도로 체크포인트됩니다.
중단되면 저장된 연결 조사와 하위 결과를 재사용합니다.

순환 그룹의 외부 의존성을 먼저 처리합니다. 순환 내부와 런타임 경계는 확인 가능한
실행 효과 및 미해결 사유를 기록합니다. 모델 제출과 사람이 원본을 직접 대조해 기록한
독립 품질 검증은 서로 다른 상태입니다.

같은 경로를 다시 등록하면 변경 파일과 조회했던 근거를 비교합니다. 영향받는 상위
결과는 오래된 상태로 표시되고, 영향을 받지 않은 같은 프로필의 결과를 재사용합니다.
후보·미해결 연결의 경우 소스가 달라지면 보수적으로 재조사합니다.

포함된 사례에서 상위 요청으로 시작하려면 check_cases를 먼저 등록하고, 반환된 해시로
아래 명령을 실행합니다. --limit은 요청의 시작 단위 수를 제한합니다. 필요한 하위 단위는
같은 실행에서 처리하며 시간과 단계 수 상한을 적용합니다.

~~~powershell
.\.venv\Scripts\python.exe -B main.py register .\check_cases
.\.venv\Scripts\python.exe -B main.py analyze SNAPSHOT --unit 'scores.py:4:1' --limit 1
.\.venv\Scripts\python.exe -B main.py export SNAPSHOT
~~~

JSON에는 단계별 Trace, 대기 경로, 하위 의미 버전, 미해결 경계가 포함됩니다.


## 단일 에이전트 전수 실험

CLI analyze에 --full을 지정하면 전체 실행 시간, 시작 단위 수, 총 단계 수 제한 없이
현재 스냅샷을 연속 처리합니다. 단위별 모델·도구 호출 한도, 요청 시간 초과와 취소는
유지하며 단위 실패와 의존 실패를 기록하고 독립 단위를 계속 처리합니다.

기존 DB를 보존하는 기준선은 저장소 루트에서 baseline.py를 사용합니다.

~~~powershell
.\.venv\Scripts\python.exe -B baseline.py --directory D:/review-experiments/rembg-baseline --root D:/project/09_The_Code/04_org_proto/97_rembg
~~~

directory는 새 실험 폴더여야 합니다. 원본 DB 백업, 실험용 DB, 고정된 Python 코드,
로컬 변경 패치, 요청별 압축 입력·응답, 사용량, 단위 상태와 결과를 보관합니다.
해당 폴더에 cancel.request 파일을 만들면 현재 작업을 중단합니다.
중단 파일을 제거한 뒤 같은 명령에 --resume을 지정하면 고정 코드와 저장된 결과로 이어갑니다.
실험 폴더에는 소스와 모델 입력이 포함됩니다.
