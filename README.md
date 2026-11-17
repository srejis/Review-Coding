# Python 코드 검수

Python 소스의 실행 동작과 파일 간 연결을 Codex로 조사하고 원본과 나란히 검수한다.
제품은 분석 대상 Python을 읽고 파싱하며, 분석 시점의 원문으로 SQLite 스냅샷을 만든다.
Codex는 선택한 스냅샷의 일부를 도구를 통해 서버에 전송한다. 비밀 파일명은 제외하지만,
일반 Python 소스에 직접 적힌 자격증명까지 전부 검출하는 기능은 없다.

## 설치 및 실행

Windows PowerShell에서 Python 3.12와 uv를 사용할 수 있다.

~~~powershell
git clone https://github.com/srejis/Review-Coding.git
Set-Location Review-Coding
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
.\.venv\Scripts\python.exe -B main.py status
.\.venv\Scripts\python.exe -B main.py review
~~~

검수 화면에서 **인증·모델**, **프로젝트 등록**, **분석·재개**를 사용한다. 로그인 화면은
기존 ChatGPT 인증을 사용할 수 없을 때 연다. 계정 변경이 필요하면 제품 전용 Codex 홈에서
공식 로그인을 진행한다. 제품은 인증 파일이나 토큰을 직접 읽지 않는다.
분석 데이터는 기본적으로 %LOCALAPPDATA%/PythonCodeReview/review.sqlite3에 저장한다.

## CLI

~~~powershell
.\.venv\Scripts\python.exe -B main.py login
.\.venv\Scripts\python.exe -B main.py register .\check_cases
.\.venv\Scripts\python.exe -B main.py analyze SNAPSHOT --limit 2 --seconds 220
.\.venv\Scripts\python.exe -B main.py export SNAPSHOT | Set-Content -Encoding utf8 "$env:LOCALAPPDATA/PythonCodeReview/report.json"
~~~

SNAPSHOT은 등록 명령이 반환한 전체 해시다. 제품 자체를 분석하려면 같은 방식으로
register . 을 실행한다. --unit UNIT으로 한 단위만 지정할 수 있다. 프로필과 스냅샷이
같으면 제출된 단위를 건너뛴다. 코드가 바뀌면 다시 등록한다. 이전 스냅샷과 결과는 검수
화면에서 다시 선택할 수 있다. 비교는 두 스냅샷 전환 또는 JSON 비교로 수행한다.

## 검증과 한계

~~~powershell
.\.venv\Scripts\python.exe -B -m unittest discover -v
~~~

연결의 확정·후보·외부 경계·미해결은 모델 제출을 표시한다. 제출 시에는 원본 위치와 실제
조회 여부를 확인하고, 의미 정확도는 검수자가 판단한다. 파싱 오류와 제외 목록은 검수
화면에 표시한다. 동적 실행 경로 전체를 복원하거나 정적 연결을 증명하지 않는다.
대형 파일은 출처를 페이지 단위로 읽는다. 단일 줄이 도구 전송 한도를 넘으면 오류를
반환한다. 기본 12개 단위 또는 300초에서 멈추며 재개할 수 있다. 공개된 도구 기록과
SDK 사용량은 내부 추론 내용과 구분하고, 토큰 수를 구독 소진율로 환산하지 않는다.
