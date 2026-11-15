# TBM 브리핑 보조앱 — 전체 인수인계 문서 (v5.2.0)

> **2026-11-16 추가: 현장톡(카카오톡 알림 자동수집 + 대화 내보내기 붙여넣기 + AI 작업기록·이벤트)** — **Worker v2.4.0 배포 완료**(wrangler 명령줄, `worker/wrangler.toml`, D1 `tbm-kakao` 연결). 남은 것: `ANTHROPIC_API_KEY` 등록(없으면 AI 정리 불가), index.html v5.3.0 GitHub 업로드, MacroDroid 알림 수신 실패 원인 확인(첫 시도에서 서버에 요청이 하나도 안 들어옴). 12장.

> POSCO 광양 2고로 개수(G2R2) 현장의 아침 TBM(작업 전 안전미팅)용 모바일 웹앱.
> 공공 API로 실시간 기상·대기질을 받아 산업안전보건법 기준으로 작업별 조치를 자동 판정하고, 시공사 작업표를 붙여넣어 관리하며, 관리자가 올린 작업을 모든 현장 사용자에게 공유한다.

---

## 1. 현재 상태 (2026년 8월 기준)

**앱(GitHub Pages)·Worker 코드 다 준비됨. Worker는 코드 수정 완료했으나 재배포 + Cloudflare 환경변수 교체가 아직 필요(아래 참고).**

- 앱 주소: `https://0toher0.github.io/tbm-brief/` (배포됨, v5.1.0)
- Worker: `https://tbm-proxy.st4gi720.workers.dev` (⚠️ 코드는 v2.2.0으로 로컬 수정됨, **아직 재배포 안 됨** — 현재 서버는 여전히 v2.1.1-debug)
- 4개 탭: 오늘 / 작업입력 / 기록 / 기준
- 핵심 기능: **관리자 공유(공용 저장)**, **기준 탭 법령·사고사례 조회**, **오늘 탭 시공사별 필터** — 전부 정상 동작

### ✅ AI 인식 폴백 — Gemini→Anthropic API로 교체 완료, 재배포 대기 (2026-09-18)
기존 문제: `/parse-ai`(Gemini API 호출)가 `"User location is not supported for the API use."` 에러를 계속 반환. 개발자 세션에서도, 실사용자(한국)가 앱에서 버튼을 눌러도 동일하게 발생 — **Cloudflare Worker가 실행되는 데이터센터의 발신 IP를 Gemini 쪽이 통째로 지역차단**한 것으로 결론(무료 등급에서 흔한 제약, Cloudflare Workers는 요청마다 다른 데이터센터에서 실행돼 특정 국가로 고정 불가).

**조치**: `worker/worker.js`의 `/parse-ai`를 Gemini → **Anthropic Claude API**(`claude-haiku-4-5-20251001`, Messages API + JSON 프리필)로 교체(지오차단 없음 — 이전에 모델명 오류(404)는 받았지만 지역차단은 없었음을 이미 확인함). 클라이언트(`index.html`)는 요청/응답 계약(`POST /parse-ai {text}` → `{rows:[...]}`)이 그대로라 수정 불필요.

**남은 작업 (사용자가 해야 함 — AI가 대신 못 함):**
1. console.anthropic.com에서 API 키 발급 (사용량 기반 소액 과금 — TBM 작업표 파싱 정도 호출량이면 부담 거의 없음, 최신 단가는 anthropic.com/pricing 참고)
2. Cloudflare 대시보드 → Workers → tbm-proxy → Settings → Variables에서 **`GEMINI_API_KEY` 대신 `ANTHROPIC_API_KEY`(Secret)** 추가
3. `worker/worker.js` 최신본을 Cloudflare 편집기에 붙여넣고 재배포 (iframe 격리로 AI가 직접 못 넣음 — 4장 참고)
4. `/health`로 `ANTHROPIC_API_KEY: set` 확인 후, 앱에서 양식 다른 표 붙여넣어 "✨ AI로 다시 인식해보기" 버튼 실사용 테스트

재배포 전까지는 `/parse-ai`가 계속 `ai_not_configured`(구 키 미인식) 또는 이전과 같은 지역차단 에러를 낼 수 있음 — 정상, 위 4단계 완료 전 상태임.

---

## 2. 아키텍처

```
[관리자·사용자 폰]
   ↓ (앱 화면)
[GitHub Pages: index.html]
   ↓ (날씨/공용작업 요청)
[Cloudflare Worker: tbm-proxy] ──→ [기상청/에어코리아 API]
   └──→ [Cloudflare KV: tbm_tasks] (공용 작업 저장소)
```

- **GitHub Pages**: 앱 HTML 호스팅
- **Cloudflare Worker**: 공공 API 프록시(서비스키 숨김) + 공용 작업 저장/조회 API
- **Cloudflare KV**: 관리자가 올린 공용 작업을 날짜별로 저장

---

## 3. 인프라 상세 (계정·주소. 비밀값은 값이 아니라 위치만 기재)

### GitHub
- 계정 `0toher0`, 저장소 `https://github.com/0toher0/tbm-brief` (Public)
- 배포법: 저장소 → `upload/main`에 index.html 드래그앤드롭 → **Commit changes 2번**(버튼+팝업). 1~2분 뒤 Pages 반영.
- ⚠️ 파일명 반드시 `index.html` 확인 (과거 index_1.html로 잘못 올라가 반영 안 된 적 있음)

### Cloudflare
- Worker명 `tbm-proxy`, 주소 `https://tbm-proxy.st4gi720.workers.dev`
- 헬스체크 `https://tbm-proxy.st4gi720.workers.dev/health` → 환경변수·KV 상태 확인 가능(값은 노출 안 됨)
- **환경변수 5개 (설정 위치: Cloudflare 대시보드 → Workers → tbm-proxy → Settings → Variables):**
  - `DATA_GO_KR_KEY` (Secret): 공공데이터포털 Decoding 서비스키
  - `SHARED_TOKEN` (Secret): 앱↔Worker 인증용. ⚠️ 참고: `index.html`의 `APP.appToken`에 그대로 박혀있어 클라이언트에서 view-source하면 보임 — 완전한 비밀이 아니라 단순 남용 방지 토큰. 값 변경 시 이 두 곳(Worker 환경변수 + index.html)을 같이 바꿔야 함.
  - `ADMIN_PASS` (Secret): 관리자 공유 업로드 암호. 진짜 비밀 — 서버(Worker)에서만 검증하고 클라이언트 코드엔 없음.
  - `ALLOWED_ORIGINS` (Text): 비어있음(전체 허용). 보안 강화 시 `https://0toher0.github.io` 넣고 재배포.
  - `ANTHROPIC_API_KEY` (Secret, **아직 미설정 — 이 이름으로 새로 추가 필요, 옛 `GEMINI_API_KEY`는 삭제해도 됨**): AI 기반 엑셀 인식(`/parse-ai`)용. console.anthropic.com에서 발급(사용량 기반 소액 과금). 없어도 나머지 기능은 정상 동작(그 기능만 에러). 1장 "AI 인식 폴백" 참고.
- **KV 저장소:** namespace명 `tbm_tasks`, Worker에 `TBM_KV`로 바인딩됨

### 공공데이터포털 (data.go.kr)
- 승인된 2개 API: 기상청_단기예보 / 에어코리아_대기오염정보
- 광양제철소 격자좌표: **nx=74, ny=69**

### Worker 엔드포인트
- `GET /forecast?nx=&ny=&base_date=&base_time=` → 기상청 단기예보
- `GET /air?sidoName=전남` → 에어코리아 대기질
- `GET /tasks` 또는 `/tasks?date=YYYY.MM.DD` → 공용 작업 조회 (모든 사용자)
- `POST /tasks` → 공용 작업 저장 (관리자만, X-Admin-Pass 헤더로 ADMIN_PASS 검증)
- `POST /parse-ai` → 엑셀 표 텍스트를 AI(Anthropic Claude)로 구조화 추출(결정론적 파서 실패시 폴백). body: `{text}`. ANTHROPIC_API_KEY 없으면 `ai_not_configured` 에러
- `GET /health` → 상태 확인
- 모든 요청에 헤더 `X-App-Token: {SHARED_TOKEN}` 필요 (단 `/kakao/*`는 예외 — 대신 `ADMIN_PASS` 필수, 12장)
- `/kakao/*` → 현장톡(카톡 수집·분석). 경로 목록은 `worker/worker.js`의 현장톡 블록 주석 참고

---

## 4. 앱 구조 (index.html 단일 파일)

### APP 설정 블록 (스크립트 최상단)
```js
const APP = {
  version : '5.1.0',
  channel : 'LTE',
  dataSource : 'proxy',   // direct(폰에 키입력) | proxy(현재) | internal(사내용,미래)
  proxyBase : 'https://tbm-proxy.st4gi720.workers.dev',
  appToken : '(값은 실제 index.html 참고 — Worker의 SHARED_TOKEN과 동일해야 함)',
};
```
- 모든 API 호출은 `fetchFeed(feedId,params)` 한 곳을 지남 → dataSource 바꾸면 direct/proxy/internal 전환 (사내망 버전 대비)

### 저장 키 (localStorage — 각 폰에만)
- `tbm3_settings` (격자·측정소 설정)
- `tbm3_records` (TBM 기록 — 개인)
- `tbm3_input` (내가 추가한 작업 — 개인)
- `tbm3_contractors` (시공사 목록)
- `tbm3_overlay` (개인 오버레이: 숨김/추가/체크)
- `tbm3_admin_pass` (관리자 인증 기억)
- `tbm3_shared_cache` (공용 작업 서버 캐시)

### 데이터 3계층 (공용 저장의 핵심)
```
공용 작업 (Cloudflare KV)  ← 관리자가 올림, 모두가 읽음
   +
개인 오버레이 (각자 폰)    ← 숨김/체크/추가
   ↓ allTasks()가 합침
화면 표시 (공용+개인 겹쳐서)
```
- 각 작업에 `taskId(r,src)`로 고유 id 부여 ('pub'=공용 / 'my'=개인추가)
- `overlay.hidden[id]` = 개인이 숨긴 작업, `overlay.checked[id]` = 안전조치 체크 상태
- 개인 변경은 그 폰에만, 공용 원본엔 영향 없음

---

## 5. 주요 기능 (탭별)

### 오늘 탭
- **날짜 선택 칩**: 여러 날짜 작업이 있으면 칩으로 전환 (오늘 날짜 자동 선택)
- **시공사 선택 칩**: 시공사가 여러 곳이면 칩으로 전환 — 누르면 그 시공사 작업만 종합판·목록·TBM 스크립트에 반영 (저장되는 TBM 기록 자체는 필터와 무관하게 항상 그날 전체 기준)
- **작업환경 종합**: 등급(양호/주의/중지·조정) + 시공사·위험작업 요약 + 인력 3칸(출력인원·작업개소·취약작업자) + 취약작업자 종류별 분해 + 날씨 4칸
- **시간대별 체감온도**: 축소 참고값
- **작업 목록**: 공용/내추가 구분 뱃지. 누르면 상세(인력·작업내용·위험유형별 유해위험·법적근거·조치 + 안전조치 체크박스 + 숨기기/삭제)
- **기상 조치사항**: 연관 작업 표기
- **TBM 스크립트**: 자동 생성 + TBM시간·특이사항 메모 → 기록 저장

### 작업입력 탭
- 엑셀 표 붙여넣기 → 자동 인식 (원본 보고서 / 표준 양식 둘 다 지원)
- **AI 인식 폴백**: 자동 인식이 0건이면 "✨ AI로 다시 인식해보기" 버튼 노출 → Worker `/parse-ai`(Gemini API, 무료 등급)로 재시도. Worker에 `GEMINI_API_KEY` 설정 전에는 에러 토스트만 뜸(정상)
- **"내 화면에 추가"** (개인) vs **"전체 공유 업로드"** (관리자 암호 필요, 초록 버튼) — 둘 다 AI 인식 결과 반영됨
- 저장된 작업 목록(공용+개인 통합)

### 기록 탭
- 일자별 TBM 기록 + PDF/엑셀(CSV) 내보내기

### 기준 탭
- 분류 칩(안전Risk유형 6종 + 기상 5종) → 요약 + 📖 법령 원문·해설 + ⚠ 사고사례를 `data/laws.json`·`data/cases.json`에서 fetch해 표시
- 사고사례는 KOSHA·고용노동부·언론 보도 등 실제 출처만 수록(포스코 광양·포항, 현대제철 당진 사례 포함). 강수/미세먼지/한파는 아직 사례 없음(조사 범위 밖)

---

## 6. 엑셀 파서 (parsePaste) — 진화 이력

**최종(v4.1.0~5.0.0): 두 형식 다 지원 + 셀 안 줄바꿈 처리**

1. **TSV 파서(parseTSV)**: 큰따옴표로 감싼 셀 내 줄바꿈/탭을 한 셀로 유지 (엑셀 복사 형식). → 작업내용·안전조치를 한 셀에 여러 줄로 적어도 그 하도사의 작업 하나로 묶임.
2. **표준 양식 파싱**: 헤더행(날짜·시공사·하도사·밀폐공간·고소작업 등)을 찾아 열 위치 자동 매핑. 앞에 빈 셀이 있어도 안 밀림.
3. **원본 보고서 파싱**: 취약작업자 셀(0/0/0/0)을 앵커로 상대 위치 파싱.
4. **위험유형**: 6칸(밀폐공간·활가스·화재폭발·철거낙하·고소작업·중량물협착)에 아무 글자(○·ㅅ·v·ㄱ 등) 있으면 인식

**과거 문제였던 것들 (다 해결됨):**
- 붙여넣기 시 앞 빈 셀 2개로 열 밀림 → 앵커/헤더 기반으로 해결
- 셀 안 줄바꿈이 새 작업으로 쪼개짐 → TSV 큰따옴표 처리로 해결
- 출력인원을 시공사 인력으로 오인 → 취약작업자 앵커 기준 상대위치로 해결

**표준 입력 양식**: `docs/TBM_작업입력_양식.xlsx` (JY가 PC에서 채우는 도구, GitHub Pages 배포엔 안 올림)
열 순서: 날짜/시공사/하도사/출력인원/취약작업자/작업내용/밀폐공간/활가스/화재폭발/철거낙하/고소작업/중량물협착/작업기간/현장책임자/안전조치

---

## 7. 안전 기준 데이터

### 안전Risk유형 6종 (RISK_TYPES)
1. 밀폐공간 (규칙 제619·619의2·620조)
2. 15m이내 활가스 배관 (COG·BFG·LDG, CO경보기)
3. 화재/폭발 (규칙 제241조)
4. 철거/낙하 (규칙 제20조)
5. 고소작업 (규칙 제42·43조)
6. 중량물협착 (신호수·양중)

### 기상 룰 (WX_RULES) — 옥외작업 전반
- 폭염: 체감 31℃↑/33℃↑(2h마다 20분 휴식 의무)/38℃↑(매시간15분, 14~17시 중지) — 2025.7.17 시행
- 강풍: 순간풍속(예보평균×1.5) 10㎧↑ 크레인 설치·해체 중지, 15㎧↑ 운전 중지 (제37조)
- 강수/미세먼지/한파 룰

### 취약작업자 4종
작업실적3회이하 / 65세이상 / 70세이상 / 입사6개월이하 (형식: `0/0/0/0`)

---

## 8. 사용법 (관리자 공유 흐름)

**관리자(JY):**
1. 작업입력 탭에서 시공사 엑셀 표 붙여넣기
2. 관리자 암호 입력 (Cloudflare `ADMIN_PASS` 값 — 위치는 3장 참고)
3. 초록색 "전체 공유 업로드" 클릭 → 모든 사용자에게 뿌려짐 (날짜별 저장)

**일반 사용자:**
1. 앱 열면 관리자가 올린 작업이 자동 표시
2. 작업 눌러 안전요소·인원 상세 확인, 안전조치 체크
3. 필요시 "내 화면에 추가"로 자기 작업 넣기, "내 화면에서 숨기기"로 개인 정리
4. (개인 변경은 그 폰에만, 남에게 영향 없음)

---

## 9. 아직 안 한 것 / 다음 작업

### 재배포 대기 (사용자 액션 필요)
- Worker `worker/worker.js` v2.2.0(Gemini→Anthropic API 교체) 로컬 수정 완료, **Cloudflare 재배포 + `ANTHROPIC_API_KEY` 설정 대기 중** (1장 참고)
- 현장톡(Worker v2.3.0 + index.html v5.2.0): **D1 생성·`KAKAO_DB` 바인딩 → Worker 재배포 → index.html 업로드 → MacroDroid 설정** (12장). 위 v2.2.0 재배포와 한 번에 하면 됨.

### 보류 중
- `resources.json`(교육자료, 3순위) — laws/cases와 같은 구조로 아직 미착수
- '기준' 탭에 강수·미세먼지·한파 사고사례 추가 (조사 범위 밖으로 남겨둠, 필요시 조사)

### 기타 향후 과제
- 같은 하도사가 여러 위치에서 작업 시 세부 작업 분리 (지금은 하도사=작업묶음 하나. 필요해지면 재검토)
- TBM 스크립트의 "[현장위치별 유의사항]" placeholder → 위치별 안전문구 매핑 제공 시 자동화
- 플랜텍·포스코DX 작업표가 같은 형식인지 실사용 검증
- ALLOWED_ORIGINS 설정으로 보안 강화 (선택)

---

## 10. 개발 참고

- 사용자(JY) 스타일: output-first. 말 설명보다 실물(파일·화면) 보며 다듬기 선호. "묻지 말고 끝까지" 진행 원함.
- 코드는 index.html 단일 파일 유지 (GitHub 교체 쉬움)
- 검증 습관: JS는 `node --check`, 렌더링은 Playwright 스크린샷(400px 모바일)
- GitHub 편집기(Monaco)·Cloudflare 편집기는 iframe 격리라 AI가 직접 코드 주입 불가 → 드래그앤드롭 업로드 또는 사용자가 붙여넣기
- Cloudflare 대시보드 작업은 스크린샷+find로 요소 특정해 진행

---

## 11. 이번까지 완료된 전체 이력 요약

- v3.0.0: 작업입력 탭 신설, 오늘 탭 종합 개편, 안전Risk 6종, 기록 PDF/엑셀
- v3.1.0: 날짜 선택 칩, 시공사 자동 분류
- v3.2.0: 엑셀 파서 앵커 방식 (앞 빈 셀 강건)
- v4.0.0: 표준 입력 양식 도입
- v4.1.0: 원본+양식 둘 다 지원, 셀 안 줄바꿈(TSV) 처리
- v5.0.0: 관리자 공유(공용 저장) — Cloudflare KV 연동, 관리자 암호, 개인 오버레이. 전체 흐름 실동작 검증 완료.
- v5.1.0: 기준 탭 개편(법령·사고사례 data/ 분리), 오늘 탭 시공사 필터 — 배포·실사용 확인 완료. 작업입력 AI 인식 폴백(Worker `/parse-ai`)은 코드·배포 다 끝났지만 Gemini 지역차단으로 실사용 불가, 보류.
- **Worker v2.2.0: `/parse-ai`를 Gemini→Anthropic Claude API로 교체(지오차단 회피, JSON 프리필 방식) — 로컬 코드 수정 완료, Cloudflare 재배포·`ANTHROPIC_API_KEY` 설정은 아직 (1장 참고). 클라이언트(index.html)는 계약 불변이라 수정 없음.**
- **v5.2.0 / Worker v2.3.0 (2026-11-16): 현장톡 탭 추가 — 카톡 알림 자동수집(MacroDroid→`/kakao/ingest`), 대화 내보내기 파일 업로드, Claude(`claude-opus-5-5`)로 완료·지시·이슈·일정·안전·자재 이벤트 추출, 체크로 완료 처리, 이전 미결 자동 해소. 저장소 D1(`KAKAO_DB`). 로컬 모의 테스트 26항목 통과 + 화면 확인. 실서버 배포·실제 카톡 알림 형식 확인은 아직 (12장).**

---

## 12. 현장톡 — 카카오톡 알림 수집·분석 (v5.2.0, Worker v2.3.0)

### 무엇을 하나
```
[내 안드로이드 폰] 카톡 알림 ──MacroDroid──▶ Worker /kakao/ingest ──▶ D1(KAKAO_DB)
[카톡 '대화 내보내기' 파일] ──앱 현장톡 탭 업로드──▶ /kakao/import ──┘
앱 현장톡 탭 "✨ AI 분석" ──▶ /kakao/analyze ──▶ Claude API ──▶ 이벤트(완료/지시/이슈/일정/안전/자재·장비/기타)
```
- 카카오톡은 대화를 읽는 공식 API가 없어서 **폰 알림을 가로채는 방식 + 가끔 내보내기 파일로 빈 곳 채우기**로 구성.
- **개인정보 보호**: 처음 보는 방은 이름·건수만 기록, 앱에서 **'추적'을 켠 방만** 본문 저장·AI 분석. 모든 `/kakao/*`는 `ADMIN_PASS` 필요(공개 앱토큰으로는 접근 불가). 탭 자체도 관리자 암호가 저장된 기기(또는 주소 끝 `#kakao`)에서만 보임.
- 중복 처리: 같은 알림 반복은 (방·보낸사람·분·내용)으로 1건만, 내보내기 업로드는 알림으로 이미 들어온 메시지(±3분)를 건너뜀.
- AI 분석: 그날 추적 방 대화를 한 번에 보내 이벤트 추출. 최근 14일 미결 목록도 함께 보내 **오늘 대화에서 완료 확인되면 자동으로 완료 처리**(근거 메모 남김). 사람이 체크한 항목은 재분석해도 덮어쓰지 않음.
- 비용(추정): Opus 5.5 단가 입력 $4/출력 $20 per 1M 토큰. 하루 메시지 1,000건 안팎이면 분석 1회 수백 원 수준. 대화가 15만 자를 넘으면 앞부분을 잘라내고 화면에 ⚠ 표시.

### 배포 순서 (사용자가 Cloudflare/GitHub/폰에서 직접)
1. **D1 생성**: Cloudflare 대시보드 → Storage & Databases → **D1** → Create → 이름 `tbm-kakao`.
2. **바인딩**: Workers → `tbm-proxy` → Settings → **Bindings** → Add → D1 database → 변수명 **`KAKAO_DB`**, DB `tbm-kakao`. (테이블은 첫 호출 때 자동 생성 — SQL 직접 실행 불필요)
3. **`ANTHROPIC_API_KEY`** Secret 설정(1장과 같은 키, 아직 안 했다면).
4. **Worker 재배포**: `worker/worker.js` 전체를 편집기에 붙여넣고 Deploy → `/health`에서 `version: 2.3.0`, `KAKAO_DB: bound` 확인.
5. **앱 배포**: `index.html`(v5.2.0) GitHub 업로드(3장 방법). 관리자 암호를 저장한 폰이면 하단에 **현장톡** 탭이 생김. 안 보이면 주소 끝에 `#kakao` 붙여 열기.
6. **MacroDroid 설정**(아래).
7. 카톡이 몇 개 오면 현장톡 탭 → '수집 중인 방'에 방들이 나타남 → **현장 방만 '추적 끔'을 눌러 '추적 중'으로**.
8. 탭 맨 아래 **'최근 수신 알림'**에서 방 이름·보낸사람이 맞게 해석되는지 확인. 틀리면 그 화면을 캡처해 주면 해석 규칙(`parseKakaoNotification`)을 조정.

### MacroDroid 매크로 (안드로이드, 무료 버전으로 충분)
- **트리거**: 알림 → 알림 수신(Notification Received) → 앱: **카카오톡** → 내용: 모든 알림.
- **동작**: 웹 상호작용 → **HTTP 요청**
  - 메서드 **POST**, URL `https://tbm-proxy.st4gi720.workers.dev/kakao/ingest`
  - 헤더: `X-Admin-Pass` = (Cloudflare `ADMIN_PASS` 값)
  - 쿼리 파라미터(값은 각 칸의 `…` 매직텍스트 버튼에서 선택): `title` = 알림 제목, `text` = 알림 텍스트, `subtext` = 알림 서브텍스트(목록에 없으면 생략)
  - 쿼리 파라미터를 쓰는 이유: MacroDroid가 자동 URL 인코딩해서 메시지 속 `&`·따옴표·줄바꿈이 깨지지 않음. (서버는 form/JSON 본문, 본문의 `k` 필드 암호도 받음)
- 폰 설정: MacroDroid **배터리 최적화 제외**, 알림 접근 권한 허용. 카톡에서 **알림을 꺼 둔 방은 알림이 안 생겨 수집되지 않음**(소리만 끄는 건 괜찮음). PC 카톡 사용 중 모바일 알림이 꺼지는 설정이 켜져 있으면 그동안 수집이 비므로 확인 필요 — 빈 곳은 내보내기 업로드로 채움.

### 내보내기 붙여넣기 → 작업 기록 (v5.3.0 / Worker v2.4.0)
카톡 방 → 메뉴(≡) → 설정 → 대화 내용 내보내기 → 받은 텍스트를 현장톡 탭 칸에 **붙여넣기**(또는 `.txt`/`.csv` 파일 선택) → 방 이름 확인 → **올리기**. '올린 뒤 바로 AI 정리'가 켜져 있으면 들어 있는 날짜를 오래된 날부터 하루씩 분석(7일 넘으면 확인창). PC(Windows)·안드로이드·iOS 텍스트, CSV 지원. 올린 방은 자동으로 추적 켜짐.
- **작업 기록**(`kakao_works`): 작업명·위치·업체·시작·종료(HH:MM)·상태(예정/진행/완료/중단)·특징(위험요소·허가·특이사항)·인원·장비.
- **중복 방지 4중**: ① 메시지 단위 중복 제거(같은 방·보낸사람·내용 ±3분) ② AI에 "흩어진 시작/완료 보고는 한 작업으로" 지시 ③ 서버에서 방+작업명(공백·기호 무시)이 같으면 병합(가장 이른 시작·가장 늦은 종료·특징 합침) ④ 같은 날 재분석은 자동 생성분을 교체(누적 안 됨), 사람이 수정한 기록(✎)은 보존.
- **여러 날 걸친 작업**: 최근 3일 미종료 작업 목록을 AI에 함께 주고, 오늘 종료가 확인되면 새로 만들지 않고 그 기록의 종료 시각·상태를 닫음(`MM-DD HH:MM` 형식).
- 작업 카드를 누르면 종료 시각·상태 수동 수정. '엑셀(CSV)' 버튼은 선택 날짜가 속한 달 전체를 내려받음.
- 로컬 모의 테스트 33항목 통과(작업 병합·전날 작업 종료·수동 수정 보존·재분석 무중복 포함). **실제 Claude 응답 품질은 `ANTHROPIC_API_KEY` 등록 후 실데이터로 확인 필요.**

### 배포 방법 (2026-11-16부터 명령줄)
`worker/` 폴더에서 `npx wrangler@4.162.0 deploy` — 설정은 `worker/wrangler.toml`(KV·D1 바인딩, 로그 끔, 기존 변수 유지). 비밀값은 Cloudflare에 저장된 것이 그대로 유지됨. 최초 1회 `npx wrangler@4.162.0 login` 필요(브라우저 승인).

### 테스트 방법(개발자용)
로컬 모의 서버: D1을 `node:sqlite`로, Anthropic 호출을 가짜 응답으로 대체해 worker.js를 그대로 실행하는 스크립트로 검증함(인증·알림 해석·중복 제거·내보내기 파서 3형식·분석 저장·이전 미결 해소·수동 체크 보존 등 26항목). 실제 Claude 호출과 실제 카톡 알림 필드 구성은 배포 후 확인 필요.
