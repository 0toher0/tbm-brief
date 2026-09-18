# TBM 브리핑 보조앱 — 전체 인수인계 문서 (v5.1.0)

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
- 모든 요청에 헤더 `X-App-Token: {SHARED_TOKEN}` 필요

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
