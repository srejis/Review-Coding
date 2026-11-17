# Review-Coding

Python 코드의 역할, 실행 효과와 연결을 원본에 대응시켜 검수합니다. Python이 스냅샷,
분석 단위, 모델 요청, 도구 실행, 결과 검증과 저장을 제어합니다. React 검수 화면은
로컬 HTTP API와 SSE로 연결됩니다.

## 설치와 실행

Python 3.12 이상, Node.js 22 이상과 OS 자격 증명 저장소가 필요합니다.
Windows PowerShell에서는 저장소 루트에서 다음을 실행합니다.

~~~powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Set-Location ui
npm ci
npm run build
Set-Location ..
.\.venv\Scripts\python.exe -B main.py review
~~~

기본 주소는 http://127.0.0.1:8765 입니다. 포트가 사용 중이면
review --port 8766으로 실행합니다. 화면의 **Continue with ChatGPT**에서 공식 로그인과
구독 사용 권한을 승인합니다. Windows 자격 증명 관리자, macOS 키체인 또는 Linux Secret
Service를 사용할 수 있어야 합니다. 토큰은 Python만 읽으며 OS 저장소 키로 암호화한 로컬
파일에 보관합니다. ChatGPT 설정의 사용량 화면에서 권한과 사용량을 관리할 수 있습니다.

프로젝트 경로를 등록하고 **분석·재개** 또는 **선택 단위 분석**을 누릅니다. 상세 항목이나
관계의 근거를 눌러 원본을 강조하고, 관계의 대상을 눌러 다른 단위로 이동합니다. Python
소스 조각은 구독 권한을 승인한 계정의 공식 OpenAI Responses API로 전송됩니다.
Luna와 medium이 기본값입니다. Luna 접근 권한이 없으면 해당 상태를 표시합니다.
모델 변경은 모델 선택창에서 직접 선택합니다.

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
