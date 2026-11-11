# Discord 실시간 번역 — 수음·전사·선택 언어 번역

프로젝트 폴더: `Programming/live_translate_api`. 웹 수신기는 옆 `Programming/live_translate_ui`에서 실행합니다.

## 번역 출력 언어 선택

`.env`의 `TRANSLATION_LANGUAGES`에 출력할 언어 코드를 쉼표로 구분해 설정합니다.
지원 코드는 `ko`(한국어), `ru`(러시아어), `kk`(카자흐어), `en`(영어)이며 하나 이상 선택해야 합니다.
기본값은 `TRANSLATION_LANGUAGES=ko,ru,kk`로 영어 출력을 비활성화합니다.
영어 출력을 다시 켜려면 `TRANSLATION_LANGUAGES=ko,ru,kk,en`으로 변경하고 봇을 재시작하세요.

비활성 언어는 번역 API 요청·응답 스키마·정확성 검증 대상에서 제외합니다.
로컬 대시보드는 선택된 언어 열만 표시하고 과거 로그는 당시 언어 구성을 유지합니다.
이 설정은 출력만 선택합니다. `STT_LANGUAGES=ko,ru,kk,en`은 유지되므로 영어로 말해도 선택된 언어로 번역됩니다.
스트리밍·분리·통합·모델 비교와 오디오 벤치마크 모두 같은 출력 설정을 사용합니다.

Discord 음성을 화자별로 받아 실시간 전사하고 선택한 언어로 번역합니다.
자막 원문과 번역은 터미널에 출력하지 않고 상세 결과는 실행별 `logs/*.log`에 저장합니다. 웹 수신기는 옆 `../live_translate_ui` 프로젝트에서 실행합니다.

다중 화자의 실제 통화 검증은 아래 A/B 수음 검증 절차를 참고하세요.

## 이미 Discord 봇을 설정했다면: 번역 실행

기존 봇이 실행 중이면 해당 터미널에서 `Ctrl+C`로 종료하세요.
기존 `.env`의 Discord 설정을 보존하고 아래 항목을 채우거나 변경하세요.
OpenAI API 키는 [API 키 관리](https://platform.openai.com/api-keys)에서 생성하며,
사용 가능한 API 크레딧과 모델 권한이 필요합니다. 키를 채팅이나 로그에 보내지 마세요.

```dotenv
TRANSLATION_ENABLED=true
OPENAI_API_KEY=여기에_실제_API_키
VOICE_CAPTURE_CONSENT_CONFIRMED=true
OPENAI_AUDIO_CONSENT_CONFIRMED=true
LOCAL_CAPTION_PREVIEW=true
STT_MODEL=gpt-live-transcribe
STT_DELAY=low
ACCURACY_REVIEW_ENABLED=true
CONTEXT_MEMORY_ENABLED=true
STT_LANGUAGES=ko,ru,kk,en
SEGMENTATION_MODEL=gpt-6.1-terra
TRANSLATION_LANGUAGES=ko,ru,kk
TRANSLATION_MODEL=gpt-6.1-terra
CAPTION_MODE=streaming
DRAFT_INTERVAL_MS=1000
SPEECH_SILENCE_MS=2000
AUDIO_SEGMENT_MS=5000
CAPTION_SILENCE_MS=4000
CAPTION_MAX_HOLD_MS=8000
STT_IDLE_TIMEOUT_MS=60000
STT_USD_PER_MINUTE=0.017
TRANSLATION_INPUT_USD_PER_MILLION=1.00
TRANSLATION_OUTPUT_USD_PER_MILLION=5.00
SEGMENTATION_INPUT_USD_PER_MILLION=1.00
SEGMENTATION_OUTPUT_USD_PER_MILLION=5.00
API_MONTHLY_LIMIT_USD=10
```

`OPENAI_AUDIO_CONSENT_CONFIRMED=true`는 참가자가 자신의 음성이 OpenAI로 전송되어
전사·번역됨을 알고 동의했을 때만 설정합니다. 혼자 시험하면 자신의 음성만 사용하세요.
`LOCAL_CAPTION_PREVIEW=true`는 터미널 출력 없이 원문·표시명·활성 언어 번역을
실행 로그 파일에 저장합니다. `NODE_ENV=production`에서는 계속 차단됩니다.
봇 실행(`npm start` / `npm run dev`)마다 `logs/2026-11-05_16-07-08-009.log` 형태의 새 파일을 만듭니다.
파일 이름은 컴퓨터의 현지 날짜·시각(밀리초 포함), 파일 안의 `at`은 UTC입니다. 같은 이름이 있으면 숫자 접미사를 붙입니다.
상세 이벤트·지연·오류·사용량 집계는 UTF-8 JSON Lines로 즉시 기록하며, 터미널에는 정상 실행 중 상세 JSON을 출력하지 않습니다.
`/stop`은 같은 파일에 모임 집계를 남깁니다. Ctrl+C는 집계 후 파일을 닫으며, 재실행할 때 새 파일을 만듭니다.
`LOCAL_CAPTION_PREVIEW=false`이면 원문·번역은 기록하거나 표시하지 않고 진단 이벤트만 파일에 저장합니다.
시작 실패나 파일 기록 실패는 터미널에도 짧게 알립니다. 기록 실패 시 실행을 종료합니다.
`logs/`는 Git 제외 대상이며 `/stop`이나 재시작으로 기존 로그를 삭제하지 않습니다. 오디오와 API 키는 로그에 저장하지 않습니다.
`.env`의 변경은 실행 중인 봇에 적용되지 않으므로 다시 시작해야 합니다.

```powershell
$env:Path = (Resolve-Path '.tools/node-v24.17.0-win-x64').Path + ';' + $env:Path
npm run doctor
npm run api:check
npm run build
npm start
```

`api:check`는 OpenAI에 모델 메타데이터만 조회합니다. 음성을 보내거나 번역을 요청하지
않으므로 생성 요금은 발생하지 않습니다. 성공해도 실제 전사·번역 동작과 품질은 별도
시험해야 합니다. `/start`, `/stop` 이름은 같으므로 기존에 등록했다면 재등록은 불필요합니다.

지정 음성 채널에 들어가 `/start`를 실행한 뒤 짧게 말하고 1초 정도 쉬세요.
기본 `streaming` 모드는 **연속 전사 → 네 언어 임시 번역 → 같은 자막 갱신 → 확정 가능한 앞부분/발언 종료 → 선택 검증 → 최종 자막**으로 처리합니다.
임시 전사부터 번역을 시작하므로 별도의 의미 구분 응답을 기다리지 않습니다.
화자별 번역 요청은 하나만 유효하게 실행하고, 처리 중 새 전사는 최신 내용 하나로 모읍니다. 기본 임시 요청 간격은 최소 1초이며 API 처리 시간은 추가됩니다.
인식 정정이나 문장 확정으로 무효가 된 임시 요청은 취소하고 최신 내용으로 교체합니다. 단순히 단어가 덧붙는 경우는 기존 응답을 활용합니다.
잦은 정정으로 번역이 끝없이 취소되지 않도록 연속 취소를 제한하며, 확정용 번역을 우선합니다. 취소 뒤 도착한 옛 응답은 자막을 덮어쓰지 않습니다.

STT는 최대 5초마다 체크포인트를 확정하고, 문장 끝 부호가 감지되면 더 일찍 확정을 요청합니다. 임시 전사의 마침표만으로 번역을 확정하지 않습니다.
확정 전사에서 마침표·물음표·느낌표로 끝나는 앞부분을 자막으로 확정하고, 뒤에 남은 발화는 다음 자막으로 이어갑니다. 소수점·알려진 약어·말줄임표는 끝 부호에서 제외합니다.
문장 끝 부호가 없는 경우에는 기존 백그라운드 의미 구분을 보조적으로 사용합니다. STT가 확정한 구두점도 실제 발화 의도와 다를 수 있으므로 중간 문장 분리가 생길 수 있습니다.
조용한 PCM 패킷은 음성으로 세지 않으며, 로컬 RMS 기반 음성 감지에서 2초간 음성이 없으면 문장이 미완성이어도 남은 STT 결과를 받은 뒤 발언을 확정합니다.
로컬 음량 감지는 음성과 큰 배경 소음을 완벽히 구분하는 의미 VAD가 아니며 실제 마이크 조건으로 확인해야 합니다.
5초는 전사 체크포인트이고 2초는 음성 무음 기준입니다. 둘 다 자막 표시까지의 전체 지연을 뜻하지 않습니다.
`CAPTION_SILENCE_MS`/`CAPTION_MAX_HOLD_MS`의 이전 4초/8초 규칙은 레거시 모드에만 적용됩니다.
`/stop`은 진행 중 요청을 취소하며 미확정 자막을 확정된 것처럼 바꾸지 않습니다.

임시·최종 원문 모두 터미널에 출력하지 않습니다. 로그 또는 웹 화면에서 확인합니다.

번역 자막에는 비속어 순화 규칙을 기본 적용합니다. 가벼운 비속어는 의미를 유지하며 순화하고,
원문 텍스트와 문맥에서 명확한 욕설·비하 표현은 해당 부분만 `***`로 표시하도록 지시합니다.
한국어·러시아어·카자흐어·영어의 초기 번역과 교정에 같은 규칙을 적용하며, 교정 때 가려진 표현을 복원하지 않습니다.
동음이의어·불확실한 STT만으로 욕설을 추측하거나 이름·성경 용어를 무조건 검열하지 않습니다.
STT 원문·분석용 문맥·녹음은 그대로 보존하므로, 웹의 원문 표시를 켜면 원래 표현을 볼 수 있습니다.
별도 검열 API 호출은 추가하지 않습니다. 기존 번역 요청의 지시문이 늘어나는 방식이며,
모델 지시 기반이므로 욕설 누락 방지를 100% 보장하거나 실제 발음이 욕설이었다고 검증하는 기능은 아닙니다.
커스텀 지시를 지원하지 않는 직접 Realtime 번역 비교 경로(`--direct`)는 이 규칙의 적용 대상이 아닙니다.
`LOCAL_CAPTION_PREVIEW=true`일 때 로그에는 아래 이력이 포함됩니다.

- `live_transcript`: 임시/확정 STT 원문과 원음 구간 ID.
- `live_translation_requested`: 실제 번역 대상, 버전, draft/settling 상태.
- `live_boundary_decision`: GPT가 나눈 앞부분과 보류한 부분, 앱이 받아들인 확정 범위.
- `live_translation_published`: 같은 자막 번호의 원문·버전·보류된 새 내용.
- `live_caption_settling`: punctuation/silence/stable_prefix/limit 확정 이유.
- `live_translation_cancelled`: source_changed/finalizing으로 교체한 임시 번역 요청.

짧은 수동 시험은 `test-script-streaming.txt`를 사용합니다.

### 브라우저 실시간 테스트 화면

봇은 기존 터미널에서 `npm start`로 실행하고, 별도 터미널에서 아래 명령을 실행합니다.

```powershell
npm run dashboard
```

브라우저에서 **http://127.0.0.1:3210**을 열면 최신 실행 로그를 실시간으로 읽습니다.
포트가 사용 중이면 `npm run dashboard -- --port 3211`로 변경할 수 있습니다.
화면은 로컬 컴퓨터에서만 접근하며, 모니터 자체는 Discord 연결이나 OpenAI 요청을 시작하지 않습니다.
`streaming` 모드와 `LOCAL_CAPTION_PREVIEW=true`에서 전체 임시 전사·번역·분할 이력을 볼 수 있습니다.

- 실시간 전사: STT가 보낸 임시 원문과 확정 원문.
- 번역 단위 추적: 실제 번역 대상·보류 부분·확정 이유·모델 응답 시간.
- 원문과 번역 표: 같은 자막 ID의 갱신 내용과 한국어·러시아어·카자흐어·영어 결과.
- 수정 이력: 행을 선택한 뒤 같은 자막의 draft/initial/final 변화를 비교.
- 처리 이벤트·필터·화면 일시정지·현재 화면 JSON 저장.
- **실행 로그 선택**: 상단 목록에서 `logs/`의 원하는 실행을 고른 뒤 **로그 열기 / 다시 읽기**를 누릅니다. **목록 새로고침**으로 새 로그를 찾을 수 있습니다. 선택 로그는 열었을 때의 화면이며, 내용이 추가되면 같은 버튼으로 다시 읽습니다. 최신 로그 자동 추적을 선택하거나 **실시간 복귀**를 누르면 최신 실행을 계속 따라갑니다.
- **화면 초기화**: 현재 브라우저 화면만 비우고 이후 새 갱신부터 표시합니다. 로그·녹음·저장 JSON은 삭제하지 않습니다. 새 실행·모임으로 바뀌면 정상 표시하며, 새로고침하면 최신 로그를 다시 읽습니다.
- **JSON 불러오기**: `화면 데이터 저장`으로 내려받은 JSON을 열어 원문·번역·수정 이력을 다시 봅니다. `recordings/`의 단일 자막 `.json`도 열 수 있습니다. 파일에 없는 전사·이전 이력은 복원하지 않습니다. 파일은 브라우저에서만 읽고 업로드하지 않습니다(최대 8MB).
- 파일 보기 중에는 실시간 로그가 화면을 덮어쓰지 않습니다. **실시간 복귀**를 누르면 최신 로그의 전체 화면으로 돌아갑니다. 저장 JSON은 당시 화면의 제한된 데이터이며 전체 실행 로그 백업은 아닙니다.

봇 재시작 시 새 로그로 자동 전환합니다. 최신 120개 자막·36개 전사 구간·자막당 16개 수정 이력만 화면 메모리에 유지하고,
전체 이력은 기존 `logs/`에 남깁니다. `화면 일시정지`는 모니터 표시만 멈춥니다.
HTTP 서버는 `.env`, 녹음 파일, 임의 파일 경로를 제공하지 않습니다. 모니터 종료는 실행 터미널의 `Ctrl+C`입니다.

### 자동 문맥과 선택 정확도 검증

세션별 주제 입력 없이 기독교 말씀나눔·기도·간증 배경과 한국어·러시아어·카자흐어·영어 힌트를 적용합니다.
번역은 원문에서 각 목표 언어로 직접 수행하며 중간 번역 언어를 사용하지 않습니다.
최근 확정 원문 최대 12개/8,000자를 화자 정보와 함께 공유하고, 더 오래된 원문은 6개 단위로
최대 1,500자의 요약을 비동기 갱신합니다. 요약 지연은 초기 번역을 막지 않으며, 모임 종료 시 문맥을 지웁니다.

임시 자막은 `status: draft`이며 같은 `sequence`의 `revision`이 증가합니다. 의미 또는 발언 종료 경계가 확정되면
`status: initial`로 선택 검증에 전달합니다. 이때 revision을 0으로 되돌리지 않습니다. 기본 1.5초 대기 없이 바로 검증 필요 여부를 판단하며,
전사 partial/final 충돌, 용어 불일치, 성경 장절, 강제 경계의 부정 표현, 늦은 정정 등 관측 가능한 경우만 검증합니다.
확보된 원음이 완전하면 `gpt-transcribe`로 독립 재전사한 뒤 GPT가 두 전사·문맥·번역을 비교합니다.
두 번째 전사가 자동으로 정답은 아니며, 근거가 부족하면 기존 번역을 유지하고 `uncertain`으로 표시합니다.
원음이 없거나 재전사에 실패하면 텍스트 근거로 번역만 검토하며 실제 발화를 확인했다고 취급하지 않습니다.
검증용 PCM은 메모리에서 최대 90초/12MB만 유지하고, 재전사 한 번은 최대 30초 분량입니다. 디스크에는 저장하지 않습니다.

같은 `sequence`의 최종 이벤트는 `status: final`이며 마지막 initial보다 큰 revision으로 한 번만 발생합니다.
확정 후 계속 재작성하지 않습니다. `accuracy.state`는 `not_needed`, `verified`, `uncertain`, `failed`, `skipped` 중 하나입니다.
소비자는 같은 `sequence`를 새 자막으로 추가하지 말고 갱신해야 합니다. 터미널에는 자막을 표시하지 않으며,
실행 로그에는 초기·최종 번역을 모두 보관합니다. 월 비용 한도는 전사·4개 번역·요약·재전사·검증이 함께 사용합니다.

### 선택 용어집 데이터 인터페이스

기본 용어집은 `src/glossary.ts`에 내장되어 항상 적용됩니다. 추가 설정 없이 은혜·구원·성령·회개·언약과
성경 인명·책 이름을 참고합니다. 등록된 용어는 발언 근거가 있을 때만 사용하며 강제 치환하지 않습니다.
선택 파일 `config/glossary.json`은 아래 형식입니다. UI는 구현하지 않았습니다.

```json
[
  { "ko": "카자흐스탄", "ru": "Казахстан" },
  { "ko": "카자흐어", "ru": "Казахский язык" },
  { "ko": "카작" }
]
```

한 항목은 같은 개념의 언어별 표기입니다. 아는 언어만 등록하고 한 언어만 넣어도 됩니다. 서로 다른 키워드는 다른 항목에 넣으세요.
최대 200개 항목, 항목당 최대 12개 언어, 표기당 1~80자를 지원합니다. 첫 번째 언어·표기를 내부 대표 용어로 사용하며 ID는 자동 생성합니다.
사람 이름은 별도 `config/participants.json`에 유지합니다. 사용자가 작성한 두 파일을 시작할 때 내부 용어집으로 합칩니다.
기존 `{ "custom": [{ "id": "example.term", "sourceTerm": "예시 용어", "translations": { "ko": "예시 용어", "en": "Example term" } }] }` 형식도 지원합니다.
기존 형식의 `sourceLanguage`는 선택입니다. 동일 `id` 또는 동일 `sourceTerm`+`sourceLanguage`의 사용자 항목이 기본값보다 우선하며,
생략한 언어의 기존 번역은 유지합니다. 참가자 이름 파일도 병합합니다. 파일이 없어도 정상 동작합니다.
`GlossaryEntry`/`GlossaryConfig`, 검증·병합 함수는 향후 UI의 CRUD 데이터와 연결할 수 있습니다.
STT에는 세션 설정 때 최대 50개 표기를 보내고, 번역·검증에는 현재 원문과 문맥에 관련된 최대 12개 항목만 전달합니다.
추가·변경 후 봇이나 벤치마크를 다시 실행하세요.

### 저장한 녹음으로 현재 설정 테스트

24kHz 모노 PCM16 WAV(최대 300초·5분)와 선택적 정답 원문 UTF-8 파일을 준비합니다.
아래 로컬 녹음 기능으로 Discord에서 직접 말한 WAV를 만들 수 있습니다.

```powershell
npm run audio:benchmark -- recording.wav --reference reference.txt
npm run audio:benchmark -- recording.wav --reference reference.txt --direct
```

실행하면 실제 유료 API를 호출합니다. 기존 봇은 먼저 종료해야 같은 사용량 잠금을 사용할 수 있습니다.
하나의 녹음을 실제 시간 속도로 재생하며 `.env`의 `STT_MODEL`, `STT_DELAY`, `TRANSLATION_MODEL`, `TRANSLATION_REASONING_EFFORT` 및 현재 번역 모드·공유 문맥·선택 검증을 적용합니다. STT는 설정한 한 경로만 실행합니다.
low/medium을 비교하려면 `STT_DELAY`를 변경해서 같은 WAV를 각각 실행하세요. `--direct`를 명시한 경우에만 별도 직접 번역 경로를 추가합니다.
`streaming`에서는 두 경로 모두 실제 운영 파이프라인의 음성 감지·체크포인트·임시 자막·백그라운드 확정을 사용합니다.
레거시 `separate/combined` 비교는 기존 고정 4초 전사 구간을 사용합니다.
`--direct`는 용어집·프롬프트 없는 `gpt-realtime-translate` 네 목표 언어 경로를 추가합니다.
STT 경로의 초기/최종 자막, 첫 출력·확정 지연, 비용 및 정답 원문 대비 CER/공백 토큰 WER를 `logs/`에 기록합니다.
벤치마크 실행 중 원문·번역과 시작·종료 안내는 터미널에 출력하지 않습니다. 오류 안내와 `--help`는 표시합니다.
`npm run dashboard`로 대시보드를 실행하면 최신 벤치마크 로그의 전사와 번역이 설정한 `STT low` 또는 `STT medium` 등의 이름으로 실시간 표시됩니다. 이전 두 경로 비교 로그도 계속 지원합니다.
기존 벤치마크 로그도 대시보드의 로그 선택 기능으로 열 수 있습니다. 선택한 과거 로그는 다시 읽기 버튼으로 갱신합니다.
CER/WER는 전사 오류 지표이며 번역 정확도 점수가 아닙니다. 의미·부정·인명·성경 인용은 사람이 정답과 비교해야 합니다.
직접 번역은 더 많은 음성 요청을 발생시키며 같은 월 한도를 사용합니다. 품질 비교를 실행하기 전에는 어느 경로가 더 정확하다고 단정하지 않습니다.

### Discord 음성 로컬 저장

`.env`에서 녹음을 켠 후 봇을 재시작하고 `/start`를 실행합니다.

```dotenv
AUDIO_RECORDING_ENABLED=true
AUDIO_RECORDING_SCOPE=admin
```

`admin`은 `ADMIN_DISCORD_USER_ID` 본인의 음성만 저장합니다. `all`을 명시하면 수신 가능한 참가자마다 파일을 분리합니다.
기본 템플릿에서는 녹음이 꺼져 있으며, 켜진 경우 `/start` 응답에 저장 대상이 표시됩니다.
번역을 끈 수음 시험에서도 녹음할 수 있습니다.

기본 `streaming` 모드는 `recordings/날짜시간/Discord사용자ID_source_001.wav`에 화자별 원음을 연속 저장합니다.
자막 갱신 때문에 원음을 자르지 않습니다. 같은 폴더의 `Discord사용자ID_caption_000001.json`은 최신 자막 상태이며,
`.jsonl`은 draft/initial/final 수정 이력입니다. 녹음 도중 종료된 draft는 `interrupted: true`로 남깁니다.
`recording.audioSpans`는 STT 원음 구간의 WAV 시각 범위이며 단어별·문장별 정확한 시각이 아닙니다.
글자 수 비율에 따른 오디오 추정 분할은 이 모드에서 사용하지 않습니다. WAV 형식의 약 4GB 한도에서만 다음 파일로 이어집니다.
`/stop`이나 `Ctrl+C`로 종료하면 마지막 WAV 헤더를 마무리합니다.

아래 번역 단위별 WAV 분할은 이전 `separate/combined/compare` 모드를 선택했을 때만 적용됩니다.
그 경우 저장 경로는 `recordings/2026-11-05_16-07-08-009/Discord사용자ID_caption_000001.wav` 형식입니다.
고정 시간으로 나누지 않고 실제 GPT 번역 단위마다 WAV 하나와 같은 이름의 자막 JSON 하나를 만듭니다.
한 번역 단위가 여러 STT 구간에 걸치면 해당 원음을 이어 붙이고, 한 STT 구간에서 여러 번역 단위가 나오면 분리합니다.
자막 번호와 녹음 번호는 같습니다. JSON에는 원문·네 언어 번역·초기/최종 상태·오디오 구간을 저장하며,
정확도 검증 후 최종 번역은 같은 JSON을 갱신합니다. WAV를 중복 생성하거나 번역 응답이 도착한 시점의 음성을 자르지 않습니다.

현재 [gpt-live-transcribe는 단어별 시각을 반환하지 않습니다](https://developers.openai.com/api/docs/guides/realtime-transcription#handle-confidence-timestamps-and-speaker-labels).
STT 구간 전체를 쓰는 경우 `recording.alignment=stt-boundary`입니다. 같은 STT 구간 내부의 문장 경계는
원문 위치에 따른 비율과 가까운 무음 구간으로 추정하며 `alignment=estimated`로 명시합니다.
따라서 번역 단위와 파일은 1:1로 대응하지만 단어의 정확한 발음 시각까지 일치한다고 보장하지 않습니다.
이 분할에는 추가 AI 요청이 없습니다.

24kHz 모노 PCM16이므로 별도 변환 없이 재생하거나 300초(5분) 이하의 파일을 비교 도구에 넣을 수 있습니다.
한 번역 단위 안에서 실제로 발생한 침묵은 보존합니다. 아주 짧은 파일은 최소 100ms까지 무음으로 채웁니다.
번역 전 임시 PCM은 `_pending/`에 보관하고, 자막에 소비된 구간은 정리합니다.
`/stop`이나 `Ctrl+C` 전에 번역되지 못한 원음은 `_untranslated_` 이름의 WAV로 보존하고 임시 파일을 정리합니다.
번역을 끈 수음 시험에서는 GPT 단위가 없으므로 기존 화자별 2분 분할을 사용합니다.
저장된 녹음은 종료 후에도 유지하며 Git에서 제외합니다.
저장 자체는 추가 AI 요청을 만들지 않습니다. 기존 번역 및 나중에 실행하는 비교 도구의 API 요금은 별도입니다.
저장 실패는 실행 로그와 짧은 오류 안내에 남기고 녹음을 중단하며, 번역은 계속할 수 있습니다.

```powershell
npm run audio:benchmark -- "recordings/날짜시간/Discord사용자ID_source_001.wav"
```

`reference.txt`는 선택 사항입니다. 필요하면 녹음을 듣고 실제 발언을 확인한 원문을 UTF-8 파일로 직접 작성하세요.
녹음에서 자동 생성한 전사를 정답 원문으로 간주하지 않습니다.

### 고정 참가자 이름 등록

`config/participants.json`에 같은 사람의 언어별 이름을 한 항목으로 저장합니다.
Discord ID나 닉네임 연결은 필요 없으며, 사람마다 1개·2개·3개 등 아는 언어만 적으면 됩니다.

```json
[
  { "ko": "[이름]", "ru": "[이름]" }
]
```

다른 사람은 배열에 새 객체로 추가합니다. 언어 코드는 `ko`, `ru`, `kk`, `en` 등을 사용하며,
모르는 언어는 빈 문자열 대신 항목 자체를 생략하세요. 번역 출력은 계속 네 언어입니다.
등록한 이름은 STT 키워드에 합쳐지고, 언어별 대응 관계는 통합·분리·모델 비교 모드의 번역 요청에 전달됩니다.
등록하지 않은 언어는 모델이 자연스럽게 표기하며, 확정된 이름 표기로 취급하지 않습니다.
관련 없는 말을 명단 속 이름으로 강제 치환하지 않으며, 번역 단계에서 `originalText`를 덮어쓰지 않습니다.
이 목록은 인식·번역 힌트이므로 실제 음성으로 정확도 개선 여부를 확인해야 합니다.

파일은 봇 시작 시 읽습니다. 변경 후 `Ctrl+C` → `npm start`로 재시작하세요.
비활성화하려면 파일을 `[]`로 비우거나 제거합니다. 파일이 없으면 `config/participants.example.json`을 복사할 수 있습니다.
등록은 최대 50명, 표기당 80자입니다. 전체 목록에서 번역에 관련된 이름을 선택하고, STT에는 다른 용어 힌트와 합쳐 최대 50개 표기만 전송합니다.
이름 힌트는 파일의 등록 순서를 우선합니다. 자주 등장하는 사람을 앞에 두세요. 이름 표기의 총합이 50개를 넘더라도 시작을 막지 않습니다.
명단 파일은 Git에서 제외합니다. 진단 로그에는 명단 수만 남기며, 실제 발언에 포함된 이름은 기존 자막 기록 정책을 따릅니다.
`npm run doctor`와 실행 로그의 `caption_pipeline_configured.participantNameEntries`에서 로드한 인원수를 확인할 수 있습니다.

혼자 할 수 있는 시험:

1. 한국어로 짧게 말하고 영어 등 네 번역 필드가 모두 나오는지 확인합니다.
2. 가능한 언어로 각각 발언하고, 한국어와 영어 또는 러시아어가 섞인 문장도 시험합니다.
3. 15초 정도 계속 말해 4초 오디오 경계가 문장 중간이어도 다음 부분과 연결되는지 확인합니다.
4. “오늘은 창세기를 살펴보겠습니다. 여기서 아담과 하와…”에서 잠깐 쉬었다가 이어 말해,
   첫 문장만 먼저 나오고 미완성 부분이 다음 발언과 연결되는지 확인합니다.
5. 미완성 발언 후 4초간 조용히 있어 남은 부분이 출력되는지 확인합니다.
6. 요청 처리 중 `/stop`을 실행해 이후 자막이 추가되지 않는지 확인합니다.
7. `/start`를 다시 실행해 새 모임으로 시작하는지 확인합니다.

모르는 언어의 번역 품질, 특히 카자흐어와 성경 고유명사는 해당 언어 사용자와 별도로
확인해야 합니다. 완성된 문장은 바로 번역 요청하지만 미완성 문장은 추가 대기시간이 있습니다.
새 모델의 실제 음성 정확도·지연은 재시험해야 합니다.

## 인식 정확도와 자막 경계 조정

이 앱은 `gpt-live-transcribe`, delay `low`를 기본 스트리밍 전사로 사용합니다.
[공식 Realtime 안내](https://developers.openai.com/api/docs/guides/realtime-transcription)는
delay `medium`은 더 많은 음성 문맥을 기다리는 비교 설정이며 고정 밀리초 지연을 뜻하지 않습니다.
기존 commit 후 전사를 비교하려면 `STT_MODEL=gpt-transcribe`, `STT_USD_PER_MINUTE=0.0045`를 사용합니다.
기본 live 모델의 요율은 `STT_USD_PER_MINUTE=0.017`입니다. 두 모델 모두 오인식 가능성이 있으므로
같은 마이크·발언으로 비교하세요. 한자·가나를 임의의 한국어로 치환하는 후처리는 하지 않습니다.

| 설정 | 기본값과 의미 |
| --- | --- |
| `STT_LANGUAGES` | `ko,ru,kk,en`: 네 입력 언어 힌트 유지, 단일 언어 강제 안 함 |
| `STT_PROMPT` | 다국어 말씀나눔이라는 배경과 언어별 표기 힌트. 최대 1000자, 빈 값이면 생략 |
| `STT_KEYWORDS` | 선택 추가 단어. 기본 용어집·참가자 이름은 별도로 자동 병합 |
| `STT_DELAY` | 기본 `low`. Discord와 WAV 테스트 모두 설정한 값 하나만 사용 |
| `ACCURACY_REVIEW_ENABLED` | `true`: 선택 검증, 초기 자막을 막지 않음 |
| `CONTEXT_MEMORY_ENABLED` | `true`: 화자 간 최근 원문·비동기 요약 공유 |
| `AUDIO_SEGMENT_MS` | `5000`: 전사 체크포인트 상한. 문장 완성·자막 확정과 별개 |
| `DRAFT_INTERVAL_MS` | `1000`: 임시 번역 요청 최소 간격. 처리 중 갱신은 하나로 병합 |
| `SPEECH_SILENCE_MS` | `2000`: 로컬 음성 감지에 따른 발언 종료 |
| `CAPTION_MODE` | `streaming`: 임시 자막 갱신 후 확정. `separate/combined/compare`: 레거시 비교 경로 |
| `TRANSLATION_MODEL` | 템플릿 `gpt-6.1-terra`, 병렬 번역 reasoning `medium`. 모델은 .env 값 사용 |
| `TRANSLATION_REASONING_EFFORT` | `medium` 기본값. `none`, `low`, `medium`, `high` 중 모델이 지원하는 값. `streaming/separate` 번역 및 WAV 비교에 적용 |
| `SEGMENTATION_MODEL` | `gpt-6.1-terra`, reasoning `none`: `separate` 모드의 문장 판단에만 사용 |
| `CAPTION_SILENCE_MS` | `4000`: 마지막 수신 음성 이후 이 시간 동안 조용하면 나머지 출력 |
| `CAPTION_MAX_HOLD_MS` | `8000`: 계속 발언 중이어도 미완성 부분을 보류하는 최대 시간 |
| `STT_IDLE_TIMEOUT_MS` | `60000`: 보통의 휴식 후에도 같은 STT 연결의 문맥 유지 |

**Terra medium 언어별 병렬 번역 모드**의 설정 예시입니다.
실제 실행은 `.env`의 값을 사용합니다.

```dotenv
CAPTION_MODE=streaming
TRANSLATION_MODEL=gpt-6.1-terra
TRANSLATION_REASONING_EFFORT=medium
TRANSLATION_INPUT_USD_PER_MILLION=1.00
TRANSLATION_OUTPUT_USD_PER_MILLION=5.00
```

`streaming/separate` 번역 reasoning은 `.env`의 `TRANSLATION_REASONING_EFFORT`로 설정합니다. 설정을 바꾼 뒤 봇이나 WAV 비교를 다시 실행하세요.
WAV 테스트도 `.env`의 STT delay와 번역 effort로 한 경로만 실행합니다. 선택적 정확도 검증과 문맥 요약은 기존 `low`를 유지합니다. 레거시 `combined` 및 8개 조합 `compare`의 effort에는 적용하지 않습니다.
통합 모드 effort는 `src/interpret.ts`의 `INTERPRETATION_REASONING_EFFORT`에 정의하며, 시작 로그에도 표시합니다.
스트리밍 대본은 `test-script-streaming.txt`를 사용합니다. 이전 대본·지연 측정치는 레거시 모드의 기록입니다.
[Terra 공식 요금](https://developers.openai.com/api/docs/models/gpt-6.1-terra)은 일반 입력 $1·출력 $5/100만 토큰으로,
Luna의 일반 토큰 단가보다 10배입니다. STT 단가와 기존 월 한도는 그대로이며, 과거 비용은 재계산하지 않습니다.
Luna로 돌아갈 때는 모델을 `gpt-6-luna`, 입력·출력 단가를 `0.10`·`0.50`으로 함께 바꾸고 재시작합니다.

동시 비교는 `.env`에 `CAPTION_MODE=compare`를 설정하고 `npm run build`, `npm start` 후 Discord에서 `/start`합니다.
같은 음성에서 STT는 한 번만 실행하고, 전사 도착·음성 활동·데이터 누락 경계를 각 경로에 전달합니다.
조합은 Luna `none/high`, Terra `none/low/medium/high`, Sol (`gpt-6.1-sol`) `low/medium`입니다.
각 경로는 문장 보류·이전 두 발언·화자별 순서를 독립 관리합니다. 느린 경로 때문에 빠른 자막을 기다리지 않습니다.
비교 모드는 모두 요청 제한 60초, 최소 출력 예산 16,384토큰(추론 포함)을 사용합니다.
단일 모드의 15초·2,048토큰 기준과 다르므로 단일 모드 실행 기록과 단순 지연 비교하지 마세요.
실제 토큰 단가는 Luna 0.10/0.50, Terra 1/5, Sol 2/10 USD/100만 입력·출력 토큰입니다.
동일한 월 예산 장부에 STT 1회와 8개 경로의 비용을 합산합니다. 예산은 자동으로 늘리지 않습니다.
알 수 없는 실패·취소 비용은 예약액을 유지하고 캐시 할인은 적용하지 않는 보수적 추정치입니다.

`caption` 결과의 `comparison.variantId`와 `sourceSegmentIds`로 조합·공통 전사 구간을 구분합니다.
`oldestTranscriptLagMs`는 해당 자막에 사용된 가장 오래된 전사가 도착한 뒤 출력까지의 시간이며 STT 시간은 제외합니다.
`newestTranscriptLagMs`는 가장 최근 전사부터의 시간입니다. 조합마다 분리 결과가 달라 동일 sequence끼리 비교하면 안 됩니다.
`comparison_request_usage`는 API 지연·토큰·추론 토큰·요청 비용을,
`/stop` 또는 Ctrl+C 후 `comparison_variant_summary`는 조합별 평균·최대 API 지연, 자막 지연 평균과 비용을 보여 줍니다.
추론 토큰은 출력 토큰의 일부이므로 비용에 중복 합산하지 않습니다. 미제공 추론 통계는 요청 로그에서 -1입니다.
종료 시 `activeRequestsAtSummary`가 0보다 크면 취소된 요청이 있으며 해당 시험은 완주 비교가 아닙니다.
모델 권한·속도 제한·타임아웃 오류가 난 경로만 중단하고 나머지는 계속합니다. 공통 인증·예산·장부 오류는 전체 중단합니다.
`LOCAL_CAPTION_PREVIEW=true`이면 원문과 번역·조합별 상세 결과를 실행 로그 파일에만 저장합니다.

70초 혼합 언어 대본은 `test-script-terra-low.txt`를 그대로 한 번 읽으면 됩니다.
마지막 발화 뒤 느린 모델의 출력이 끝날 때까지 기다렸다가 `/stop`하세요(요청 하나는 최대 60초).
별도 `npm run captions:matrix-check`는 Discord 없이 합성 예문 1개로 8개 조합의 실제 API 접근을 확인합니다(유료).
고정 입력 API 검사와 실시간 독립 문장 분리 시험은 서로 다른 측정입니다.

처리 순서는 **Discord 수음 → GPT-Transcribe → 설정한 모델(현재 Terra)의 의미 단위 구분 + 4개 언어 번역 → 출력**입니다.
같은 화자의 보류 부분과 새 전사, 짧은 이전 문맥만 보냅니다. 마침표가 있어도
“여기서 아담과 하와.”처럼 의미가 미완성인 부분은 다음 전사까지 보류하도록 요청합니다.
응답의 원문 조각들과 보류 부분이 입력을 순서대로 정확히 나눈 것인지 코드에서도 검사합니다.
원문의 글자를 바꾸거나 빼거나 중복하면 응답을 거부합니다. 번역은 원문과 별도 필드로 받습니다.
`originalText`와 보류 원문은 전사 오류도 그대로 보존합니다. 번역 필드에서는 현재 문장과
이전 문맥이 한 가지 의미를 강하게 뒷받침할 때만 명백히 손상된 일반 단어를 해석하도록 합니다.
실제 이름·숫자·부정 표현을 문맥에 맞춰 바꾸거나, 근거가 부족한 단어를 추측해서는 안 됩니다.
이 처리는 번역 지침이며 음성 인식 모델·오디오를 교정하는 기능은 아닙니다.
모델의 의미 판단 자체가 항상 정확하다고 보장하지는 않습니다.
입력 전체를 읽고 연결되는 명사구·서술부를 먼저 확인하도록 지시합니다. 예를 들어
“여기서 가장 중요한 것은.”은 뒤의 설명이 필요하므로 보류하고, “이제 작동. 상태를 확인하려고…”는
‘작동 상태’라는 연결을 유지합니다. 명사만 보고 ‘작동한다’는 새 단정을 만들지 않도록 합니다.
“네/Yes/Да/Иә”처럼 의미가 완결된 짧은 응답은 즉시 출력 대상입니다.

한 화자는 통합 요청을 한 번에 하나만 실행하고, 새 전사는 다음 요청으로 모읍니다.
새 내용이 없는 보류 부분은 새 전사나 무음·보류 상한이 오기 전까지 재요청하지 않습니다.
전체 동시 통합 요청은 최대 3개이며, 이미 반환된 번역을 별도 번역 API로 다시 보내지 않습니다.
전사 실패 구간이나 실제 무음으로 닫힌 묶음은 이후 발언과 합치지 않습니다.
8초 상한이 요청 처리 중 만료되더라도, 응답이 오래된 부분을 모두 처리했으면 남은 조각의
원래 수신 시각으로 만료 여부를 재판단합니다. 응답 시점부터 8초를 새로 부여하지는 않습니다.
일시적 실패에는 원문을 보존한 강제 번역을 한 번 시도합니다. 이 요청도 실패하면
`interpretation_failed`로 중지하고, 대기 상한 초과는 `interpretation_backpressure`로 중지합니다.
인증·모델 접근·예산·사용량 저장 오류에도 모임을 중지합니다.

`CAPTION_MODE=separate`이면 **공유 의미 단위 판단 → 설정한 모델의 4개 언어 병렬 번역**을 수행합니다.
같은 마이크·대본·말하는 타이밍으로 두 모드를 비교하세요. 통합 모드는 모델의 역할도 달라지므로
요청 횟수 감소만으로 속도나 품질 향상을 단정하지 않습니다.

고정 예문으로 API 단계만 비교하려면 봇을 종료한 상태에서 `npm run captions:compare`를 실행합니다.
한국어 경계·이어진 문장·강제 출력과 영어·러시아어·카자흐어 예문 6개를 두 방식에 보내므로
**실제 API 요금이 발생하며 기존 월 한도에 기록**됩니다. Discord나 마이크를 사용하지 않습니다.
각 예문의 요청 수·처리 시간·보류 여부·번역 결과를 터미널에서 확인할 수 있습니다.
`boundaryCheck`는 예상 원문 경계 검사이며 번역 품질 점수가 아닙니다. 단회 측정이므로
실제 통화의 지연 감소나 언어별 정확도를 보장하는 수치로 해석하지 마세요.

`npm run captions:compare -- --boundaries`는 통합 API에 단독 미완성 조각과 직전 문맥을 포함하는
12개 예문을 보내며, 연결된 구절을 쪼개지 않는지와 짧은 완결 응답의 즉시 출력을 검사합니다.
번역 전체의 품질 검증은 아니며, 실통화 정확도·지연은 별도로 확인해야 합니다.

전사 오류가 번역으로 전파되는 사례는 `npm run captions:compare -- --recognition`으로 검사합니다.
‘작 상태’·‘몸맥’ 같은 손상된 일반 단어와 실제 제품명·부정 표현·모르는 단어·미완성 조각을
구분하는 고정 예문 7개이며, 실제 API 요금이 기존 월 한도에 기록됩니다.
이 검사는 녹음된 음성을 다시 전사하거나
네 언어의 전반적인 번역 정확도를 평가하는 시험이 아닙니다.

자막의 `boundary`는 `semantic`(AI 문장 판단), `silence`(무음), `timeout`(보류 상한),
`limit`(길이·버퍼 제한), `gap`(수신 공백), `fallback`(문장 판단 실패)을 구분합니다.
`sourceSegmentIds`는 자막에 포함된 전사 구간입니다. 통합 모드의 `interpretation_ready.latencyMs`는
판단과 번역을 합친 API 처리 시간입니다. 기존 모드의 `segmentation_ready.latencyMs`와
`translation_ready.latencyMs`는 각각 판단과 번역의 처리 시간입니다.
`caption_ready.mode`와 `caption_pipeline_configured`에서 현재 모드를 확인할 수 있습니다.
`interpretation_hold_rebased`는 앞 문장이 처리되어 남은 새 조각의 보류 시간을 재평가했음을 뜻합니다.
원문이나 번역은 일반 진단 로그에 포함하지 않습니다.
이전 `CAPTION_HOLD_MS`는 더 이상 운영 설정에 사용하지 않습니다.

전사 구간을 4초로 줄여 완성된 문장을 더 일찍 판단하고, 미완성 부분도 8초 보류 상한 전에
다음 전사와 연결할 기회를 줍니다. 통합 응답의 완성 부분은 보류 시간을 기다리지 않고 출력합니다.
4초는 자막 표시 시간의 보장이 아니며, 전사·통합 API 처리 시간이 별도로 필요합니다.
짧은 구간에서는 요청이 더 자주 발생할 수 있으므로 실제 지연·인식 품질·비용을 함께 비교하세요.

용어 힌트는 모임 시작 전 진행자가 선택적으로 등록하는 방식으로 확장할 예정입니다.
등록하지 않아도 시작할 수 있고, 용어가 없으면 전사 API의 `keywords` 필드를 생략합니다.
현재 진행자 등록 화면·명령은 아직 구현하지 않았으며, 고정된 기본 용어는 넣지 않습니다.

화자별 전사 완료 순서를 정렬하고 같은 화자의 번역은 차례대로 처리합니다. 서로 다른
화자는 계속 병렬 처리합니다. 한 화자의 전사 실패 구간을 건너뛰어 양쪽 문장을 이어 붙이지
않습니다. 용어 힌트는 실제로 말하지 않은 단어를 삽입하라는 지시가 아니며, 이 역시 실음성
평가 시 확인해야 합니다.

## 준비

- Node.js **24.17.0 이상**, npm
- Discord Developer Portal의 애플리케이션과 봇
- 일반 음성 채널 1개, 관리자 Discord 사용자 ID; 다중 화자 시험에는 참가자 2명
- 참가자 전원의 사전 고지 및 동의

Node.js를 `.tools/node-v24.17.0-win-x64`에 설치한 경우 PowerShell에서 다음과 같이 실행 경로를 설정합니다.

```powershell
$env:Path = (Resolve-Path '.tools/node-v24.17.0-win-x64').Path + ';' + $env:Path
node --version
```

다른 컴퓨터에서는 [공식 Node.js 배포판](https://nodejs.org/en/download)을 설치하세요.
네이티브 Opus/DAVE 바이너리는 OS와 Node 버전에 맞아야 하므로 `node_modules`를
다른 컴퓨터에 복사하지 말고 그 컴퓨터에서 `npm ci`로 설치하세요.

```powershell
npm ci --cache .npm-cache
npm run check
npm run doctor -- --audio-only
```

`check`는 TypeScript 검사 → 자동 테스트 → 빌드를 실행합니다. `doctor --audio-only`는
합성 440Hz 음원으로 네이티브 Opus 및 24kHz 모노 출력을 확인합니다. 두 명령 모두
Discord 접속, 마이크 사용, OpenAI API 호출, 음성 파일 저장을 하지 않습니다.

## Discord 설정과 실행

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱과 봇을 만듭니다.
2. 봇을 대상 서버에 `bot`, `applications.commands` 범위로 설치합니다.
   대상 음성 채널에서 **View Channel**, **Connect** 권한을 허용합니다.
   봇 전체에 Administrator 권한을 부여할 필요가 없습니다.
3. Discord 개발자 모드를 켜고 앱 ID, 서버 ID, 음성 채널 ID, 관리자 사용자 ID를 확인합니다.
4. 아래 명령으로 `.env`를 **처음 한 번만** 만들고 다섯 가지 값을 입력합니다.
   이미 `.env`가 있다면 덮어쓰지 마세요. 토큰은 채팅이나 버전 관리에 올리지 마세요.

```powershell
Copy-Item .env.example .env
```

5. 참가자 전원의 동의를 확보한 뒤 `VOICE_CAPTURE_CONSENT_CONFIRMED=true`로 설정합니다.
   false이면 `/start`는 수신을 시작하지 않습니다. 통화 중 새로 들어오는 참가자에게도
   운영자가 먼저 고지하고 동의를 확인해야 합니다.
6. 설정을 확인하고 명령을 등록한 뒤 봇을 실행합니다.

```powershell
npm run doctor
npm run register
npm run build
npm start
```

`register`는 지정 서버의 `/start`, `/stop` 두 명령을 생성·갱신합니다.
같은 애플리케이션의 다른 명령을 일괄 삭제하지 않습니다.
명령 실행은 지정 서버의 `ADMIN_DISCORD_USER_ID`만 허용됩니다.
명령 응답은 실행한 관리자에게만 보입니다.

개발 중에는 `npm run dev`로 실행할 수 있습니다. 별도 privileged intent 없이
`Guilds`, `GuildVoiceStates`만 사용합니다. `.env` 변경 후에는 봇을 재시작하세요.

## 실제 A/B 수음 검증 절차 — 아직 미수행

1. 동의한 A와 B가 지정 음성 채널에 입장합니다.
2. 관리자가 대상 서버에서 `/start`를 실행합니다.
3. 봇 입장과 `logs/`의 최신 실행 파일에서 `meeting_started`를 확인합니다.
4. **5분 동안** A/B가 10~20초씩 번갈아 말합니다. 중간에 긴 발언, 1초 이상의
   무음, 짧은 동시 발언, 한 참가자의 퇴장·재입장도 시험합니다.
5. 관리자가 `/stop`을 실행합니다. 봇 퇴장과 `meeting_stopped`를 확인합니다.
6. 실행 로그 파일에서 각 `speaker_summary`의 `speakerId`를 A/B ID와 대조합니다.

통과 확인 사항:

- A와 B 모두 `packets > 0`, `pcmBytes > 0`, `audioMs > 0`
- `capture_summary.elapsedMs >= 300000`
- 실제 발언을 한 두 ID 모두 여러 차례 수신되며 `streams`가 증가함
- `decodeErrors = 0`, `receiveErrors = 0` (오류가 있으면 원인을 해결하고 재시험)
- `/stop` 뒤 추가 수신이 없고 봇이 퇴장함
- 다시 `/start`하면 이전 모임의 수신 집계 없이 새로 시작함

`audioMs`는 **디코딩된 패킷의 음성 시간**입니다. 무음을 포함하는 모임 시간과 다르며,
동시 발언은 사용자별 합계이므로 전체 모임 시간보다 클 수 있습니다.
5분 경과와 패킷 수만으로 대화 품질을 자동 합격 처리하지 않습니다. 운영자가 A/B의
실제 발언 시점과 수신 로그를 함께 확인해야 합니다.

## 동작과 개인정보

- `selfDeaf: false`, `selfMute: true`로 지정 음성 채널에 입장합니다.
- 사용자 ID별 Opus 스트림에 별도 디코더를 사용합니다.
- libopus가 입력 Opus를 **PCM s16le / mono / 24,000Hz**로 직접 변환합니다.
  FFmpeg를 따로 설치할 필요가 없습니다.
- 기본 850ms 무음에서 각 수신 스트림을 닫고, 다음 발언 때 다시 구독합니다.
- 번역 모드에서는 약 100ms 단위로 PCM을 전송하고, 무음 또는 최대 4초 경계에서
  수동 commit합니다. 100ms 미만의 발화는 전송하지 않습니다.
- 활성 STT 연결은 최대 3개입니다. 네 번째 동시 발언은 `stt_capacity`와 함께 누락될 수
  있습니다. 연결 대기 오디오는 화자당 최대 한 구간으로 제한하고 넘치면 해당 연결을 정리합니다.
- 화자별 원문 1~2개를 짧은 문장 구분·번역 문맥으로 사용합니다. 조합된 자막 문장당 번역 요청은 1회이며,
  한 응답에 `ko`, `ru`, `kk`, `en`을 받습니다. 부분 전사는 표시하지 않습니다.
- 잘못된 패킷이나 사용자별 스트림 오류를 다른 화자에게 전파하지 않습니다.
- 참가자 이탈, 봇 이동·deafen, Gateway 단절, `/stop`, 프로세스 종료 시 수신을 정리합니다.
- 음성 전송 연결은 라이브러리의 재연결을 최대 15초 기다립니다. 복구하지 못하거나
  Gateway가 끊기면 모임을 종료하므로, 연결 복구 후 관리자가 `/start`를 다시 실행합니다.
- 로컬 녹음을 끄면 오디오를 파일에 저장하지 않습니다. 켜면 지정 대상의 WAV를 `recordings/`에 유지합니다.
  전달용으로 복사한 PCM 버퍼는 전송 또는 폐기 후
  0으로 덮어씁니다. 네이티브 내부 메모리·전송 계층의 즉시 보안 삭제까지 보장하지는 않습니다.
- 자막과 짧은 문장 구분·번역 문맥은 10분이 지나면 만료하며, 메모리 정리는 최대 30초 간격으로 실행합니다. `/stop` 즉시 제거합니다.
  진행 중인 요청은 취소하고 늦게 도착한 결과를 버립니다.
- 기본 로그 파일은 사용자 ID·패킷 수·시간·오류 코드 등 진단 메타데이터를 포함합니다.
  로컬 미리보기를 켜면 표시명·원문·번역도 같은 파일에 저장합니다. 터미널에는 자막을 출력하지 않습니다.
  저장된 로그 파일은 `/stop`으로 지워지지 않습니다.
- `TRANSLATION_ENABLED=false`이면 수음 시험만 합니다. true이면 OpenAI로 음성·텍스트가
  전송되고 API 요금이 발생합니다. 문장 구분·번역 요청에는 `store:false`를 사용합니다.
  대화 문맥에는 화자를 구별하는 ID와 표시명이 포함될 수 있습니다. 제공자 보관 정책은 앱과 별개입니다.

## 비용 기록과 제한

`data/usage.json`에는 UTC 월별 오디오 시간·토큰 수·추정 비용만 저장됩니다. 원문, 번역,
음성, 사용자 ID는 이 파일에 저장하지 않습니다. 요청 전에 최대 예상 비용을 예약하고,
확인된 사용량으로 정산합니다. 실패·취소 등으로 과금 여부를 모르면 예약 비용을 유지하므로
대시보드보다 보수적으로 집계될 수 있습니다. 모델의 실패 응답도 과금될 가능성을 고려합니다.

- 기본 API 한도: 월 **$10**. `API_MONTHLY_LIMIT_USD`로 변경합니다. 호스팅 요금은 별도입니다.
- 한도 초과 또는 사용량 파일 저장 오류 시 모임을 중지하고 추가 전송을 차단합니다.
- `data/usage.json`을 지우면 누적 비용이 초기화되므로 삭제하지 마세요.
- `data/usage.json.lock`은 동시에 실행한 두 봇의 중복 지출을 막습니다. 정상 종료 시
  해제되며 종료된 프로세스의 잠금은 회수합니다. 먼저 기존 봇을 종료하세요.
- 이 한도는 **앱의 추정 한도**입니다. 실제 청구 금액은 OpenAI 사용량 화면으로 확인하세요.
- 다른 모델로 바꾸면 `STT_USD_PER_MINUTE`, `TRANSLATION_INPUT_USD_PER_MILLION`,
  `TRANSLATION_OUTPUT_USD_PER_MILLION`, `SEGMENTATION_INPUT_USD_PER_MILLION`,
  `SEGMENTATION_OUTPUT_USD_PER_MILLION` 중 해당 단계의 요금도 수정해야 합니다.
- 현재 템플릿은 [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)의
  STT $0.017/분, [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)의 입력 $1·출력 $5/100만 토큰을 사용합니다.
  문장 구분·언어별 번역·비동기 요약·검증 요청은 실제 단계별 토큰을 각각 계산합니다.
  독립 재전사는 [GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)의 $0.0045/분,
  선택 직접 번역 비교는 [GPT-Realtime-Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate)의 $0.034/분을 요청별 적용합니다.
  네 목표 언어의 직접 번역 비교는 음성도 네 번 청구됩니다. 모든 요청은 동일한 월 한도를 공유합니다.
  각 요청의 비용은 해당 모델의 단가로 계산합니다. 과거 비용은 새 요금으로 재계산하지 않습니다.

## 문제 해결

| 현상 | 확인 |
| --- | --- |
| Node 버전 오류 | 새 터미널의 `node --version`, 위 로컬 PATH 설정 |
| `doctor`에 필수 설정 누락 | `.env.example`을 참고해 `.env`를 작성 |
| 명령 등록 실패 `10004` | 봇을 대상 서버에 서버 설치(Guild Install)하고 서버 ID 확인 |
| 명령 등록 실패 `50001` / `50013` | `bot`, `applications.commands` 범위로 서버에 설치했는지 확인; 사용자 설치만으로는 부족 |
| 명령 등록 실패 `401` | Client Secret이 아닌 Bot Token인지 확인 |
| `/start` 거절 | 관리자 ID, 서버 ID, 동의 설정 확인 |
| 음성 연결 실패 | 일반 음성 채널 ID, View Channel/Connect 권한, UDP 통신 확인 |
| 입장했지만 패킷 없음 | 봇의 server deafen 상태, 실제 A/B 발언, `doctor`의 Opus/DAVE 확인 |
| 네이티브 모듈 로딩 실패 | 지원 Node 버전에서 `npm ci` 재실행; 사전 빌드가 없는 OS는 C++ 빌드 도구 필요 |
| `stt_auth` / `interpretation_auth` / `segmentation_auth` / `authentication` | `OPENAI_API_KEY`, 해당 프로젝트의 API 권한 확인 |
| `stt_model` / `interpretation_model` / `segmentation_model` / `model_access` | 현재 모드의 지정 모델을 사용할 수 있는지 `npm run api:check`로 확인 |
| `interpretation_failed` | 통합 요청과 강제 번역 모두 실패하여 중지됨; 앞선 `pipeline_error` 코드 확인 |
| `interpretation_backpressure` | 통합 API가 발언 속도를 따라가지 못해 대기 상한 도달; 모임 중지 후 API 지연 확인 |
| `segmentation_invalid_response` / `segmentation_timeout` | 문장 판단에 실패해 원문을 그대로 전달한 상태; `fallback` 자막과 다음 정상 요청 여부 확인 |
| `translation_backpressure` | 번역이 발언 속도를 따라가지 못해 대기 상한에 도달함; 모임 중지 후 API 응답 지연 확인 |
| `stt_language_hint` | 지원 언어 힌트 확인. 필요하면 `STT_LANGUAGES=`로 비워 단일 언어를 강제하지 않고 재시험 |
| `stt_rate_limit` / `rate_limit` | API 크레딧·프로젝트 한도 확인 후 재시험; 실패한 음성을 자동 재전송하지 않음 |
| `api_budget_limit` | 월 누적 추정 지출과 설정한 API 한도 확인 |
| `usage_storage_error` | 기존 봇 프로세스, data 폴더 권한과 사용량 파일 손상 확인; 사용량 기록을 삭제하지 않음 |
| 로그에 `caption_ready`가 있는데 터미널에 원문이 없음 | 정상 동작입니다. 로그·대시보드 또는 웹 수신기에서 확인하세요. |

## 구현 상태와 다음 단계

| 항목 | 상태 |
| --- | --- |
| 관리자 명령, 지정 채널 접속, 다중 사용자 수신 | 구현 |
| 합성 Opus → PCM 변환, 접근 제한, 스트림 수명주기 | 로컬 자동 검증 |
| 실제 A/B 5분 Discord 수음 | 보류, 참가자 확보 후 필요 |
| Phase 2: STT 및 4개 언어 번역 | 단독 실통화에서 동작 확인; 추가된 AI 문장 구분의 실통화 지연·정확도 재검증 필요 |
| Phase 3: OAuth 및 비공개 웹 자막 | 후속 단계 |
| 모임 시작 전 진행자의 선택적 용어 등록 | 후속 기능; 용어 없이도 시작 가능 |
| Phase 4: 2시간 운영·비용·50명 부하 시험 | 후속 단계 |

현재 `@discordjs/node-pre-gyp`가 사용하는 `tar`는 보안 수정 버전 `7.5.22`로
`overrides`에 고정했습니다. 의존성 변경 시 `npm audit`와 네이티브 설치를 다시 확인하세요.

## 공식 참고 자료

- [Discord Voice 0.19.2](https://discord.js.org/docs/packages/voice/0.19.2): 음성 수신은 Discord가 안정성을 보장하는 공개 프로토콜이 아니므로 실제 통화 검증이 필요합니다.
- [AudioReceiveStream](https://discord.js.org/docs/packages/voice/0.19.2/AudioReceiveStream:Class)
- [libopus API](https://opus-codec.org/docs/opus_api-1.5.pdf)
- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription): 24kHz PCM, 수동 append/commit, 복수 언어 힌트를 사용합니다.
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [OpenAI API 데이터 보관 정책](https://developers.openai.com/api/docs/guides/your-data)
