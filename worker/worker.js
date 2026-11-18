/**
 * TBM 브리핑 보조앱 — 데이터 프록시 (Cloudflare Workers)
 * =====================================================
 * 역할: 앱 대신 공공API를 호출하고, 서비스키를 앱에 노출하지 않는다.
 *
 * 앱이 보내는 요청 (키 없음):
 *   GET {worker}/forecast?base_date=20260729&base_time=0800&nx=74&ny=69
 *   GET {worker}/air?sidoName=전남
 *
 * 이 Worker가 하는 일:
 *   1) 경로(/forecast, /air)를 실제 공공API 엔드포인트로 매핑
 *   2) serviceKey와 고정 파라미터를 여기서 주입 (앱은 키를 모름)
 *   3) 공공API 응답 JSON을 그대로 반환 (+ CORS 헤더)
 *   4) 허용된 Origin + 공유 토큰만 통과시켜 무단 사용 차단
 *
 * ── 배포 전 설정 (Cloudflare 대시보드 → Workers → Settings → Variables) ──
 *   [Secret] DATA_GO_KR_KEY   : 공공데이터포털 일반 인증키(Decoding). 절대 코드에 넣지 말 것.
 *   [Secret] SHARED_TOKEN     : 앱과 나눠 갖는 임의 문자열(아무 긴 랜덤값). 아래 앱 APP.appToken과 동일해야 함.
 *   [Var]    ALLOWED_ORIGINS  : 앱이 배포된 주소(쉼표 구분). 예) https://xxx.netlify.app,https://아이디.github.io
 *   [Secret] ANTHROPIC_API_KEY : (선택) 엑셀 표 형식이 달라 자동인식 실패 시 AI로 대신 추출하는 /parse-ai용.
 *                               console.anthropic.com → API Keys에서 발급(사용량 기반 소액 과금,
 *                               현재 호출량 기준 부담 거의 없음 — 최신 요금은 anthropic.com/pricing 참고).
 *                               없으면 /parse-ai는 ai_not_configured 에러만 반환하고
 *                               나머지 기능(날씨/공용작업)은 그대로 동작함.
 *                               (2026-08: Gemini 무료 API를 썼었으나 Cloudflare Worker 발신 IP가
 *                               지역차단당해 실사용 불가 확인 → Anthropic API로 교체, 지오차단 없음 확인됨)
 */

// 논리적 피드 id → 실제 공공API 매핑. 새 API 추가 시 여기에 한 줄만.
const FEED_MAP = {
  forecast: {
    url: 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst',
    fixed: { numOfRows: '500', pageNo: '1', dataType: 'JSON' },
    allow: ['base_date', 'base_time', 'nx', 'ny'], // 앱이 넘길 수 있는 파라미터 화이트리스트
  },
  air: {
    url: 'https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty',
    fixed: { returnType: 'json', numOfRows: '200', pageNo: '1', ver: '1.0' },
    allow: ['sidoName'],
  },
};

export default {
  // 이 밑에서 무슨 에러가 나든(어디서든) Cloudflare의 뭉뚱그린 1101 에러 대신
  // 실제 에러 메시지를 JSON으로 그대로 돌려준다 — Observability 설정 없이도 디버깅 가능.
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'unhandled_exception',
        message: String((e && e.message) || e),
        stack: e && e.stack ? String(e.stack) : undefined,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : '');

    const cors = {
      'Access-Control-Allow-Origin': okOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-App-Token, X-Admin-Pass, Content-Type',
      'Cache-Control': 'no-store',
    };

    // Preflight
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // 헬스체크: 배포 여부와 환경변수 설정 상태 확인 (값은 노출 안 함)
    // 사용: {worker}/health  → 브라우저로 열어 배포 성공·환경변수 세팅 확인
    if (url.pathname.replace(/^\/+/, '') === 'health') {
      return json({
        ok: true,
        worker: 'tbm-proxy',
        version: '2.11.0',
        env: {
          DATA_GO_KR_KEY: env.DATA_GO_KR_KEY ? 'set' : 'MISSING',
          SHARED_TOKEN: env.SHARED_TOKEN ? 'set' : 'MISSING',
          ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || '(open: all origins)',
          ADMIN_PASS: env.ADMIN_PASS ? 'set' : 'MISSING',
          TBM_KV: env.TBM_KV ? 'bound' : 'MISSING',
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? 'set' : 'MISSING (optional — /parse-ai, /kakao/analyze만 영향)',
          KAKAO_DB: env.KAKAO_DB ? 'bound' : 'MISSING (optional — 현장톡 기능만 영향)',
        },
      }, 200, cors);
    }

    // ===== 현장톡 (카카오톡 알림 수집·분석) — 관리자 전용, 아래 handleKakao 참고 =====
    // 폰 자동화앱(MacroDroid)은 Origin/앱토큰 없이 호출하므로 일반 검사 전에 분기하고,
    // 대신 ADMIN_PASS로 모든 경로를 보호한다(개인 대화 내용이므로 공유 토큰으로는 부족).
    if (url.pathname.replace(/^\/+/, '').split('/')[0] === 'kakao') {
      if (origin && allowed.length && !allowed.includes(origin)) return json({ error: 'origin_not_allowed' }, 403, cors);
      return await handleKakao(request, env, url, cors);
    }
    // ===== 현장메모 (순시 메모: 엑셀 표 서식 그대로 / 이미지) — 관리자 전용, 아래 handleMemo 참고 =====
    if (url.pathname.replace(/^\/+/, '').split('/')[0] === 'memo') {
      if (origin && allowed.length && !allowed.includes(origin)) return json({ error: 'origin_not_allowed' }, 403, cors);
      return await handleMemo(request, env, url, cors);
    }

    // Origin 차단 (허용목록이 설정된 경우)
    if (allowed.length && !allowed.includes(origin)) {
      return json({ error: 'origin_not_allowed' }, 403, cors);
    }

    // 공유 토큰 검사 (헤더 우선, 쿼리 fallback)
    const token = request.headers.get('X-App-Token') || url.searchParams.get('t') || '';
    if (env.SHARED_TOKEN && token !== env.SHARED_TOKEN) {
      return json({ error: 'invalid_token' }, 401, cors);
    }

    // ===== 공용 작업 공유 (Cloudflare KV) =====
    // GET  /tasks            → 공유된 모든 날짜의 작업 목록 반환 { updatedAt, dates:{ 'YYYY.MM.DD':[...] } }
    // GET  /tasks?date=...   → 특정 날짜만
    // POST /tasks            → 관리자만. body: { pass, date, tasks:[...] } 또는 { pass, all:{date:[...]} }
    //   헤더 X-Admin-Pass 또는 body.pass 로 ADMIN_PASS 검증
    const path0 = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (path0 === 'tasks') {
      if (!env.TBM_KV) return json({ error: 'kv_not_bound' }, 500, cors);
      const KEY = 'shared_tasks_v1';

      if (request.method === 'GET') {
        const raw = await env.TBM_KV.get(KEY);
        const data = raw ? JSON.parse(raw) : { updatedAt: null, dates: {} };
        const date = url.searchParams.get('date');
        if (date) {
          return json({ updatedAt: data.updatedAt, date, tasks: (data.dates && data.dates[date]) || [] }, 200, cors);
        }
        return json(data, 200, cors);
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
        const pass = request.headers.get('X-Admin-Pass') || body.pass || '';
        if (!env.ADMIN_PASS || pass !== env.ADMIN_PASS) {
          return json({ error: 'admin_auth_failed' }, 401, cors);
        }
        // 기존 로드
        const raw = await env.TBM_KV.get(KEY);
        const data = raw ? JSON.parse(raw) : { updatedAt: null, dates: {} };
        if (!data.dates) data.dates = {};

        if (body.all && typeof body.all === 'object') {
          // 여러 날짜 한번에 교체 (올린 날짜만 갱신, 나머지 유지)
          for (const [d, arr] of Object.entries(body.all)) {
            if (Array.isArray(arr)) data.dates[d] = arr;
          }
        } else if (body.date && Array.isArray(body.tasks)) {
          data.dates[body.date] = body.tasks;
        } else if (body.clearDate) {
          delete data.dates[body.clearDate];
        } else {
          return json({ error: 'bad_payload' }, 400, cors);
        }
        data.updatedAt = new Date().toISOString();
        await env.TBM_KV.put(KEY, JSON.stringify(data));
        return json({ ok: true, updatedAt: data.updatedAt, dates: Object.keys(data.dates) }, 200, cors);
      }

      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    // ===== AI 기반 작업표 파싱 (Anthropic Claude API) =====
    // POST /parse-ai  body: { text: "<붙여넣은 원본 텍스트>" }
    // 결정론적 파서(parsePaste, 앱 쪽)가 실패했을 때만 클라이언트가 호출하는 폴백.
    // 2026-08엔 Gemini 무료 API를 썼으나 Cloudflare Worker 발신 IP가 지역차단당해
    // 실사용 불가였음 → Anthropic API로 교체(지오차단 없음 확인됨). 응답은 클라이언트의
    // normalizeAiRows()가 필드 누락을 방어하므로 여기선 그대로 통과시킨다.
    if (path0 === 'parse-ai') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'ai_not_configured' }, 500, cors);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
      const text = String(body.text || '').slice(0, 20000); // 과금 방지용 길이 상한
      if (!text.trim()) return json({ error: 'empty_text' }, 400, cors);

      const prompt = `아래는 건설현장 TBM(작업 전 안전미팅)용으로 붙여넣은 작업표입니다. 엑셀에서 복사한 표라 형식이 정형화되어 있지 않을 수 있습니다(열 순서가 다르거나, 표준 양식이 아니거나, 여러 표가 섞여 있을 수 있음). 표에 있는 각 작업 행을 정확히 추출해서, 다음 JSON 형식으로만 응답하세요(다른 텍스트나 설명, 마크다운 코드펜스 없이 JSON 객체만):

{"rows":[{
  "date": "작업 날짜, YYYY.MM.DD 형식. 없으면 빈 문자열",
  "contractor": "시공사(원청)명",
  "subcon": "하도사명",
  "headcount": "출력인원 숫자(문자열)",
  "vulnerable": "취약작업자 4종을 실적3회이하/65세이상/70세이상/입사6개월이하 순서로 슬래시 구분한 숫자. 예: 0/2/0/1. 정보 없으면 0/0/0/0",
  "task": "작업내용 전체 텍스트",
  "risks": ["밀폐공간","15m이내 활가스 배관","화재/폭발","철거/낙하","고소작업","중량물협착" 중 표에 체크·마킹된 것만, 배열로],
  "period": "작업기간",
  "manager": "현장책임자명(연락처 포함 가능)",
  "safety": "안전조치 내용 전체 텍스트"
}]}

원문에 없는 정보는 지어내지 말고 빈 문자열/빈 배열로 두세요. contractor와 task가 없는 행은 결과에서 제외하세요.

---
${text}
---`;

      try {
        const model = 'claude-haiku-4-5-20251001';
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            messages: [
              { role: 'user', content: prompt },
              { role: 'assistant', content: '{' }, // JSON 시작을 강제(프리필)해 형식 이탈 방지
            ],
          }),
        });
        const data = await r.json();
        if (!r.ok) return json({ error: 'anthropic_error', detail: data }, 502, cors);
        const continuation = data?.content?.[0]?.text;
        if (continuation === undefined) return json({ error: 'no_structured_output', detail: data }, 502, cors);
        const raw = '{' + continuation;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { return json({ error: 'bad_ai_json', raw }, 502, cors); }
        return json({ rows: parsed.rows || [] }, 200, cors);
      } catch (e) {
        return json({ error: 'ai_request_failed', message: String(e) }, 502, cors);
      }
    }

    // 경로 → 피드
    const feedId = url.pathname.replace(/^\/+/, '').split('/')[0];
    const feed = FEED_MAP[feedId];
    if (!feed) return json({ error: 'unknown_feed', feedId }, 404, cors);

    // 파라미터 조립: 화이트리스트로 받은 것만 + 고정값 + 키(주입)
    const params = new URLSearchParams();
    params.set('serviceKey', env.DATA_GO_KR_KEY || '');
    for (const [k, v] of Object.entries(feed.fixed)) params.set(k, v);
    for (const k of feed.allow) {
      const v = url.searchParams.get(k);
      if (v !== null) params.set(k, v);
    }

    const target = feed.url + '?' + params.toString();
    try {
      const upstream = await fetch(target, { cf: { cacheTtl: 0 } });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
      });
    } catch (e) {
      return json({ error: 'upstream_failed', message: String(e) }, 502, cors);
    }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/* =====================================================================
 * 현장톡 — 카카오톡 알림 자동수집 + 대화 내보내기 업로드 + AI 이벤트 추출
 * =====================================================================
 * 저장소: Cloudflare D1 (바인딩명 KAKAO_DB). KV는 무료 쓰기 한도(1,000회/일)가
 *   단톡방 메시지량에 부족해서 D1(100,000행/일)을 쓴다. 테이블은 첫 호출 때 자동 생성.
 * 인증(v2.9.0~): 앱 공유 토큰(X-App-Token / 필드 t) 또는 ADMIN_PASS(X-Admin-Pass / 필드 k) 중 하나.
 *   사용자 결정(2026-11-18)으로 앱에서는 암호 없이 사용 — 공유 토큰은 앱 코드에 공개돼 있어 실질 보호는 약함.
 *
 *   POST /kakao/ingest     폰 알림 1건. 필드: title, text, subtext(선택), app(선택)
 *                          (form-urlencoded / JSON / 쿼리 모두 허용 — MacroDroid용)
 *   POST /kakao/import     내보내기 파일에서 파싱한 메시지 묶음 {room, messages:[{ts,sender,text}]}
 *   GET  /kakao/days       메시지가 있는 날짜 목록(최근 60일)
 *   GET  /kakao/summary?day=YYYY-MM-DD   그날 분석결과 + 이벤트 + 이전 미결
 *   GET  /kakao/messages?day=&room=      원문 보기
 *   GET  /kakao/rooms      방 목록(추적 여부·건수) / POST {room, tracked}
 *   POST /kakao/analyze    {day}  추적 중인 방의 그날 대화를 Claude로 분석해 이벤트 저장
 *   POST /kakao/event      {id, status:'open'|'done'}  체크 토글
 *   GET  /kakao/works?from=&to=   작업 기록(작업명·시작·종료·상태·특징·인원·장비) 기간 조회
 *   POST /kakao/work       {id, status?, end_at?}  작업 기록 수동 수정(재분석해도 보존)
 *   POST /kakao/star       {type:'work'|'event', id, starred}  ★주요 표시(재분석해도 보존)
 *   GET  /kakao/starred?from=&to=  ★표시한 작업·이벤트를 날짜순으로 (주요 이벤트 시트)
 *   GET  /kakao/raw        최근 수신 원본 30건(파싱 확인용, 본문은 앞 40자만 보관)
 *
 * 개인정보: 추적(tracked)으로 켠 방의 메시지만 본문을 저장한다. 처음 보는 방은
 *   방 이름·건수만 기록되고, 앱에서 '추적'을 켠 이후부터 저장된다.
 */
// 현장톡·순시메모 접근: 앱 공유 토큰 또는 관리자 암호 중 하나면 통과
function kakaoMemoAuthOk(request, env, body) {
  const pass = request.headers.get('X-Admin-Pass') || body.k || '';
  const tok = request.headers.get('X-App-Token') || body.t || '';
  if (env.ADMIN_PASS && pass === env.ADMIN_PASS) return true;
  return !env.SHARED_TOKEN || tok === env.SHARED_TOKEN;
}

let KAKAO_SCHEMA_READY = false;
async function kakaoSchema(db) {
  if (KAKAO_SCHEMA_READY) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_rooms (room TEXT PRIMARY KEY, tracked INTEGER NOT NULL DEFAULT 0, seen_count INTEGER NOT NULL DEFAULT 0, first_seen TEXT, last_seen TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL, src TEXT NOT NULL, UNIQUE(room, sender, ts, text))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kakao_msgs_day ON kakao_msgs(day, room)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_events (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, room TEXT, kind TEXT, title TEXT, detail TEXT, who TEXT, at TEXT, status TEXT NOT NULL DEFAULT 'open', manual INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kakao_events_day ON kakao_events(day)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_analysis (day TEXT PRIMARY KEY, summary TEXT, msg_count INTEGER, truncated INTEGER, model TEXT, analyzed_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_works (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, room TEXT, wkey TEXT, title TEXT, place TEXT, company TEXT, start_at TEXT, end_at TEXT, status TEXT, features TEXT, people TEXT, equipment TEXT, manual INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kakao_works_day ON kakao_works(day)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kakao_raw (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, title TEXT, subtext TEXT, text40 TEXT, room TEXT, sender TEXT, stored INTEGER)`),
    // v2.10.0: 일일 작업현황 공지(진도율·출력인원·장비) — 날짜당 1건
    db.prepare(`CREATE TABLE IF NOT EXISTS site_daily (day TEXT PRIMARY KEY, data TEXT NOT NULL, raw TEXT, src TEXT, updated_at TEXT)`),
  ]);
  // v2.5.0: ★주요 표시 컬럼 (이미 있으면 에러 → 무시)
  for (const t of ['kakao_works', 'kakao_events']) {
    try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`).run(); } catch (e) { /* 이미 있음 */ }
  }
  KAKAO_SCHEMA_READY = true;
}

// 한국시간(KST, UTC+9) 기준 'YYYY-MM-DD HH:MM'
function kstNow() {
  const s = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
  return { ts: s.slice(0, 10) + ' ' + s.slice(11, 16), day: s.slice(0, 10) };
}
function addMinutes(ts, m) {
  const d = new Date(ts.replace(' ', 'T') + ':00Z');
  return new Date(d.getTime() + m * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

// 카카오톡 알림 → {room, sender, text}. 기종/버전마다 필드 구성이 달라 방어적으로 해석한다.
//   1:1     title=보낸사람, text=메시지
//   단톡    title=보낸사람, subtext=방이름   또는  title=방이름, text="보낸사람 : 메시지"
function parseKakaoNotification(title, text, subtext) {
  title = String(title || '').trim();
  text = String(text || '').trim();
  subtext = String(subtext || '').trim();
  if (!title || !text) return null;
  // 요약/시스템성 알림은 버린다 (예: "새 메시지 3개", "3개의 안 읽은 메시지")
  if (/^(새\s*메시지\s*\d+개|\d+개의\s*(새로운\s*|안\s*읽은\s*)?메시지)/.test(text)) return null;
  if (subtext && !/^\d+$/.test(subtext)) return { room: subtext, sender: title, text };
  const m = text.match(/^([^:\n]{1,20}?)\s?:\s([\s\S]+)$/);
  if (m && !/^\d/.test(m[1])) return { room: title, sender: m[1].trim(), text: m[2].trim() };
  return { room: title, sender: title, text };
}

async function readKakaoBody(request, url) {
  const out = Object.fromEntries(url.searchParams.entries());
  if (request.method !== 'POST') return out;
  const ct = request.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) Object.assign(out, await request.json());
    else if (ct.includes('form')) {
      const fd = await request.formData();
      for (const [k, v] of fd.entries()) out[k] = String(v);
    } else {
      const t = await request.text();
      if (t.trim().startsWith('{')) Object.assign(out, JSON.parse(t));
      else Object.assign(out, Object.fromEntries(new URLSearchParams(t).entries()));
    }
  } catch (e) { out.__bad = String(e); }
  return out;
}

async function handleKakao(request, env, url, cors) {
  const sub = url.pathname.replace(/^\/+/, '').split('/')[1] || '';
  const body = await readKakaoBody(request, url);
  if (body.__bad) return json({ error: 'bad_body', message: body.__bad }, 400, cors);
  // 2026-11-18 사용자 결정: 앱에서는 관리자 암호 없이 사용. 앱에 내장된 공유 토큰(X-App-Token)만 확인해
  // 주소만 아는 자동 수집기 접근을 막는다(진짜 비밀은 아님 — HANDOFF 12장 참고). 폰 MacroDroid는 기존처럼 관리자 암호도 허용.
  if (!kakaoMemoAuthOk(request, env, body)) return json({ error: 'auth_failed' }, 401, cors);
  if (!env.KAKAO_DB) return json({ error: 'kakao_db_not_bound' }, 500, cors);
  const db = env.KAKAO_DB;
  await kakaoSchema(db);
  const now = kstNow();

  // ---- 폰 알림 수신 ----
  if (sub === 'ingest') {
    const p = parseKakaoNotification(body.title, body.text, body.subtext);
    if (!p) return json({ ok: true, skipped: 'empty_or_summary' }, 200, cors);
    const roomRow = await db.prepare(`SELECT tracked FROM kakao_rooms WHERE room=?`).bind(p.room).first();
    const tracked = roomRow ? roomRow.tracked === 1 : false;
    const stmts = [
      db.prepare(`INSERT INTO kakao_rooms(room, tracked, seen_count, first_seen, last_seen) VALUES(?,0,1,?,?)
                  ON CONFLICT(room) DO UPDATE SET seen_count=seen_count+1, last_seen=excluded.last_seen`).bind(p.room, now.ts, now.ts),
      db.prepare(`INSERT INTO kakao_raw(at,title,subtext,text40,room,sender,stored) VALUES(?,?,?,?,?,?,?)`)
        .bind(now.ts, String(body.title || '').slice(0, 60), String(body.subtext || '').slice(0, 60), String(body.text || '').slice(0, 40), p.room, p.sender, tracked ? 1 : 0),
      db.prepare(`DELETE FROM kakao_raw WHERE id <= (SELECT MAX(id) - 30 FROM kakao_raw)`),
    ];
    if (tracked) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO kakao_msgs(room,sender,text,ts,day,src) VALUES(?,?,?,?,?,'noti')`)
        .bind(p.room, p.sender, p.text.slice(0, 4000), now.ts, now.day));
    }
    await db.batch(stmts);
    return json({ ok: true, room: p.room, sender: p.sender, stored: tracked }, 200, cors);
  }

  // ---- 내보내기 파일 업로드 (앱에서 파싱해 400건씩 보냄) ----
  if (sub === 'import') {
    const room = String(body.room || '').trim();
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!room || !msgs.length) return json({ error: 'bad_payload' }, 400, cors);
    if (msgs.length > 500) return json({ error: 'too_many', max: 500 }, 400, cors);
    const stmts = [
      db.prepare(`INSERT INTO kakao_rooms(room, tracked, seen_count, first_seen, last_seen) VALUES(?,1,0,?,?)
                  ON CONFLICT(room) DO UPDATE SET tracked=1`).bind(room, now.ts, now.ts),
    ];
    let valid = 0;
    for (const m of msgs) {
      const ts = String(m.ts || '');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ts) || !m.sender || !m.text) continue;
      valid++;
      // 알림으로 이미 들어온 같은 메시지(수신 시각이 1~2분 다를 수 있음)는 건너뛴다
      stmts.push(db.prepare(`INSERT OR IGNORE INTO kakao_msgs(room,sender,text,ts,day,src)
        SELECT ?,?,?,?,?,'export' WHERE NOT EXISTS (
          SELECT 1 FROM kakao_msgs WHERE room=? AND sender=? AND text=? AND ts BETWEEN ? AND ?)`)
        .bind(room, String(m.sender).slice(0, 60), String(m.text).slice(0, 4000), ts, ts.slice(0, 10),
              room, String(m.sender).slice(0, 60), String(m.text).slice(0, 4000), addMinutes(ts, -3), addMinutes(ts, 3)));
    }
    const res = await db.batch(stmts);
    const inserted = res.slice(1).reduce((a, r) => a + ((r.meta && r.meta.changes) || 0), 0);
    return json({ ok: true, room, received: msgs.length, valid, inserted, duplicates: valid - inserted }, 200, cors);
  }

  if (sub === 'days') {
    const r = await db.prepare(`SELECT day, COUNT(*) AS n FROM kakao_msgs GROUP BY day ORDER BY day DESC LIMIT 60`).all();
    const a = await db.prepare(`SELECT day, analyzed_at FROM kakao_analysis ORDER BY day DESC LIMIT 60`).all();
    return json({ today: now.day, days: r.results, analyzed: a.results }, 200, cors);
  }

  if (sub === 'rooms') {
    if (request.method === 'POST') {
      const room = String(body.room || '').trim();
      if (!room) return json({ error: 'bad_payload' }, 400, cors);
      const tracked = body.tracked === true || body.tracked === 'true' || body.tracked === 1 || body.tracked === '1' ? 1 : 0;
      await db.prepare(`INSERT INTO kakao_rooms(room, tracked, seen_count, first_seen, last_seen) VALUES(?,?,0,?,?)
                        ON CONFLICT(room) DO UPDATE SET tracked=excluded.tracked`).bind(room, tracked, now.ts, now.ts).run();
    }
    const r = await db.prepare(`SELECT r.room, r.tracked, r.seen_count, r.last_seen,
        (SELECT COUNT(*) FROM kakao_msgs m WHERE m.room=r.room) AS stored
      FROM kakao_rooms r ORDER BY r.tracked DESC, r.last_seen DESC`).all();
    return json({ rooms: r.results }, 200, cors);
  }

  if (sub === 'messages') {
    const day = String(body.day || now.day);
    const room = body.room ? String(body.room) : null;
    const q = room
      ? db.prepare(`SELECT id, room, sender, text, ts, src FROM kakao_msgs WHERE day=? AND room=? ORDER BY ts, id LIMIT 2000`).bind(day, room)
      : db.prepare(`SELECT id, room, sender, text, ts, src FROM kakao_msgs WHERE day=? ORDER BY ts, id LIMIT 2000`).bind(day);
    return json({ day, messages: (await q.all()).results }, 200, cors);
  }

  if (sub === 'raw') {
    const r = await db.prepare(`SELECT * FROM kakao_raw ORDER BY id DESC LIMIT 30`).all();
    return json({ raw: r.results }, 200, cors);
  }

  if (sub === 'summary') {
    const day = String(body.day || now.day);
    const [an, ev, prev, cnt, wk] = await db.batch([
      db.prepare(`SELECT * FROM kakao_analysis WHERE day=?`).bind(day),
      db.prepare(`SELECT * FROM kakao_events WHERE day=? ORDER BY at, id`).bind(day),
      db.prepare(`SELECT * FROM kakao_events WHERE day<? AND day>=date(?, '-30 day') AND status='open' AND kind IN ('지시','이슈','일정','안전','자재·장비') ORDER BY day DESC, at LIMIT 100`).bind(day, day),
      db.prepare(`SELECT room, COUNT(*) AS n FROM kakao_msgs WHERE day=? GROUP BY room ORDER BY n DESC`).bind(day),
      db.prepare(`SELECT * FROM kakao_works WHERE day=? ORDER BY CASE WHEN start_at='' THEN '99' ELSE start_at END, id`).bind(day),
    ]);
    return json({ day, analysis: an.results[0] || null, events: ev.results, openPrev: prev.results, msgCounts: cnt.results, works: wk.results }, 200, cors);
  }

  // ---- 일일 작업현황 (카톡 공지: 진도율·출력인원·장비). 앱이 파싱해 보냄. 날짜당 1건, 다시 올리면 덮어씀 ----
  if (sub === 'report') {
    if (request.method === 'POST') {
      const day = String(body.day || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !body.data || typeof body.data !== 'object') return json({ error: 'bad_payload' }, 400, cors);
      const data = JSON.stringify(body.data);
      if (data.length > 300000) return json({ error: 'too_large' }, 400, cors);
      const prev = await db.prepare(`SELECT day FROM site_daily WHERE day=?`).bind(day).first();
      await db.prepare(`INSERT INTO site_daily(day,data,raw,src,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET data=excluded.data, raw=excluded.raw, src=excluded.src, updated_at=excluded.updated_at`)
        .bind(day, data, String(body.raw || '').slice(0, 30000), String(body.src || 'paste').slice(0, 20), now.ts).run();
      return json({ ok: true, day, replaced: !!prev }, 200, cors);
    }
    const r = await db.prepare(`SELECT * FROM site_daily WHERE day=?`).bind(String(body.day || '')).first();
    return json({ report: r ? { ...r, data: JSON.parse(r.data) } : null }, 200, cors);
  }
  if (sub === 'reports') {
    const from = String(body.from || '2000-01-01'), to = String(body.to || '2999-12-31');
    const r = await db.prepare(`SELECT day, data, updated_at FROM site_daily WHERE day BETWEEN ? AND ? ORDER BY day DESC LIMIT 400`).bind(from, to).all();
    return json({ reports: r.results.map(x => ({ day: x.day, updated_at: x.updated_at, data: JSON.parse(x.data) })) }, 200, cors);
  }
  if (sub === 'report-delete') {
    if (request.method !== 'POST') return json({ error: 'post_only' }, 405, cors);
    const r = await db.prepare(`DELETE FROM site_daily WHERE day=?`).bind(String(body.day || '')).run();
    return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0 }, 200, cors);
  }

  // 작업 기록 기간 조회 (CSV 내보내기용) GET /kakao/works?from=YYYY-MM-DD&to=YYYY-MM-DD
  if (sub === 'works') {
    const from = String(body.from || '2000-01-01'), to = String(body.to || '2999-12-31');
    const r = await db.prepare(`SELECT * FROM kakao_works WHERE day BETWEEN ? AND ? ORDER BY day, start_at, id`).bind(from, to).all();
    return json({ works: r.results }, 200, cors);
  }

  if (sub === 'event') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    const id = parseInt(body.id, 10);
    const status = body.status === 'done' ? 'done' : 'open';
    if (!id) return json({ error: 'bad_payload' }, 400, cors);
    await db.prepare(`UPDATE kakao_events SET status=?, manual=1, updated_at=? WHERE id=?`).bind(status, now.ts, id).run();
    return json({ ok: true, id, status }, 200, cors);
  }

  // 이전 미결 일괄 처리: {before:'YYYY-MM-DD'} → 그 날짜 이전의 미결(이전 미결 목록과 같은 종류) 전부 완료
  //                      {ids:[...], status:'open'} → 되돌리기
  if (sub === 'events-bulk') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    const status = body.status === 'open' ? 'open' : 'done';
    let ids = Array.isArray(body.ids) ? body.ids.map(x => parseInt(x, 10)).filter(Boolean).slice(0, 2000) : [];
    if (!ids.length && /^\d{4}-\d{2}-\d{2}$/.test(String(body.before || '')) && status === 'done') {
      const r = await db.prepare(`SELECT id FROM kakao_events WHERE day<? AND status='open' AND kind IN ('지시','이슈','일정','안전','자재·장비') LIMIT 2000`).bind(String(body.before)).all();
      ids = r.results.map(x => x.id);
    }
    if (!ids.length) return json({ ok: true, ids: [], changed: 0 }, 200, cors);
    const res = await db.batch(ids.map(id => db.prepare(`UPDATE kakao_events SET status=?, manual=1, updated_at=? WHERE id=?`).bind(status, now.ts, id)));
    const changed = res.reduce((a, r) => a + ((r.meta && r.meta.changes) || 0), 0);
    return json({ ok: true, ids, status, changed }, 200, cors);
  }

  // ★주요 표시 토글 {type:'work'|'event', id, starred}. 표시한 항목은 manual=1이 되어 재분석해도 보존
  if (sub === 'star') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    const id = parseInt(body.id, 10);
    const table = body.type === 'event' ? 'kakao_events' : body.type === 'work' ? 'kakao_works' : null;
    if (!id || !table) return json({ error: 'bad_payload' }, 400, cors);
    const on = body.starred === true || body.starred === 1 || body.starred === '1' || body.starred === 'true' ? 1 : 0;
    await db.prepare(`UPDATE ${table} SET starred=?, manual=1, updated_at=? WHERE id=?`).bind(on, now.ts, id).run();
    return json({ ok: true, id, starred: on }, 200, cors);
  }

  // ★주요 이벤트 시트: 기간 내 표시한 작업·이벤트를 날짜순으로 GET /kakao/starred?from=&to=
  if (sub === 'starred') {
    const from = String(body.from || '2000-01-01'), to = String(body.to || '2999-12-31');
    const [w, e] = await db.batch([
      db.prepare(`SELECT 'work' AS type, id, day, room, title, place, company, start_at, end_at, status, features, people, equipment, note FROM kakao_works WHERE starred=1 AND day BETWEEN ? AND ?`).bind(from, to),
      db.prepare(`SELECT 'event' AS type, id, day, room, kind, title, detail, who, at, status, note FROM kakao_events WHERE starred=1 AND day BETWEEN ? AND ?`).bind(from, to),
    ]);
    const items = [...w.results, ...e.results].sort((a, b) => (a.day + (a.start_at || a.at || '99')).localeCompare(b.day + (b.start_at || b.at || '99')));
    return json({ from, to, items }, 200, cors);
  }

  // 작업 기록 수동 수정 (종료시각·상태). 수정한 항목은 재분석해도 보존
  if (sub === 'work') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    const id = parseInt(body.id, 10);
    if (!id) return json({ error: 'bad_payload' }, 400, cors);
    const cur = await db.prepare(`SELECT * FROM kakao_works WHERE id=?`).bind(id).first();
    if (!cur) return json({ error: 'not_found' }, 404, cors);
    const status = KAKAO_WORK_STATUS.includes(body.status) ? body.status : cur.status;
    const endAt = body.end_at !== undefined ? String(body.end_at).slice(0, 5) : cur.end_at;
    await db.prepare(`UPDATE kakao_works SET status=?, end_at=?, manual=1, updated_at=? WHERE id=?`).bind(status, endAt, now.ts, id).run();
    return json({ ok: true, id, status, end_at: endAt }, 200, cors);
  }

  if (sub === 'analyze') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ai_not_configured' }, 500, cors);
    const day = String(body.day || now.day);
    return json(await analyzeKakaoDay(db, env, day, now), 200, cors);
  }

  return json({ error: 'unknown_kakao_route', sub }, 404, cors);
}

const KAKAO_EVENT_KINDS = ['완료', '지시', '이슈', '일정', '안전', '자재·장비', '기타'];
const KAKAO_WORK_STATUS = ['예정', '진행', '완료', '중단'];
// 중복 판정용 키: 방 + 작업명(공백·기호 제거)
const workKey = (room, title) => `${room}|${String(title || '').replace(/[\s·.,\-_/()\[\]]/g, '').toLowerCase()}`;
const KAKAO_MAX_CHARS = 150000; // 한 번 분석에 넣는 대화 길이 상한(비용 보호). 넘으면 최근 대화 위주로 넣고 truncated 표시

async function analyzeKakaoDay(db, env, day, now) {
  const [msgsR, prevR, prevWorkR] = await db.batch([
    db.prepare(`SELECT m.room, m.sender, m.text, m.ts FROM kakao_msgs m JOIN kakao_rooms r ON r.room=m.room
                WHERE m.day=? AND r.tracked=1 ORDER BY m.room, m.ts, m.id`).bind(day),
    db.prepare(`SELECT id, day, room, kind, title FROM kakao_events WHERE day<? AND day>=date(?, '-14 day') AND status='open'
                AND kind IN ('지시','이슈','일정','안전','자재·장비') ORDER BY day DESC LIMIT 80`).bind(day, day),
    // 전날까지 끝나지 않은 작업(야간작업·여러 날 작업) — 오늘 종료되면 새로 만들지 않고 이어서 닫는다
    db.prepare(`SELECT id, day, room, title, place, company, start_at FROM kakao_works WHERE day<? AND day>=date(?, '-3 day')
                AND status IN ('예정','진행') ORDER BY day DESC, start_at LIMIT 60`).bind(day, day),
  ]);
  const msgs = msgsR.results;
  if (!msgs.length) return { ok: false, error: 'no_messages', day };

  // 방별로 묶어 "[HH:MM] 보낸사람: 내용" 형태로. 길면 각 방의 앞부분부터 잘라낸다(최근 대화 보존).
  const byRoom = {};
  for (const m of msgs) (byRoom[m.room] = byRoom[m.room] || []).push(`[${m.ts.slice(11)}] ${m.sender}: ${m.text.replace(/\n/g, ' / ')}`);
  let blocks = Object.entries(byRoom).map(([room, lines]) => ({ room, lines }));
  let total = blocks.reduce((a, b) => a + b.lines.join('\n').length, 0);
  let truncated = false;
  while (total > KAKAO_MAX_CHARS) {
    const big = blocks.reduce((a, b) => (b.lines.length > a.lines.length ? b : a));
    const drop = Math.max(1, Math.floor(big.lines.length * 0.1));
    total -= big.lines.slice(0, drop).join('\n').length;
    big.lines = big.lines.slice(drop);
    truncated = true;
  }
  const convo = blocks.map(b => `### 방: ${b.room}\n${b.lines.join('\n')}`).join('\n\n');
  const prevList = prevR.results.map(e => `- id ${e.id} (${e.day}, ${e.room || ''}, ${e.kind}) ${e.title}`).join('\n') || '(없음)';
  const prevWorkList = prevWorkR.results.map(w => `- id ${w.id} (${w.day} ${w.start_at || '?'} 시작, ${w.room || ''}) ${w.title}${w.place ? ' / ' + w.place : ''}${w.company ? ' / ' + w.company : ''}`).join('\n') || '(없음)';

  const prompt = `당신은 건설현장(포스코 광양 2고로 개수공사) 관리자의 보좌관입니다. 아래는 관리자가 속한 현장 카카오톡 방들의 ${day} 대화입니다.
관리자가 놓치면 안 되는 사항을 이벤트로 뽑아 주세요.

이벤트 종류(kind):
- 완료: 작업·공정·조치가 끝났다는 보고 (예: "OO 배관 용접 완료", 사진과 함께 "끝났습니다")
- 지시: 누군가에게 요청·지시된 일 (아직 끝났다는 말이 없음)
- 이슈: 문제·하자·지연·민원·사고 직전 상황·변경 요청
- 일정: 검사·입회·회의·반입·작업 예정 시각 등 날짜/시간이 있는 약속
- 안전: 안전 관련 지적·위험 보고·작업중지·허가 관련
- 자재·장비: 자재 반입·부족, 장비 고장·투입
- 기타: 위에 안 맞지만 관리자가 알아야 할 결정사항

규칙:
- 대화에 근거가 있는 것만. 추측해서 만들지 말 것. 인사·잡담·단순 확인("네", "알겠습니다")은 제외.
- 같은 일에 대한 여러 메시지는 하나로 합칠 것. 지시 후 같은 날 완료 보고가 있으면 kind=완료, status=done 하나로.
- title은 25자 안팎의 짧은 한 줄(무엇을/어디서), detail은 근거가 되는 핵심 내용과 수치·위치·업체명.
- who는 보고하거나 요청받은 사람/업체, at은 근거 메시지의 HH:MM, room은 방 이름 그대로.
- status: 완료면 "done", 그 외는 "open".
- summary: 그날 전체를 관리자 관점에서 3~6줄로 요약(완료된 것, 남은 것, 주의할 것).
- 아래 '이전 미결 목록' 중 오늘 대화에서 처리·완료가 확인되는 항목이 있으면 resolved_prev에 그 id와 근거를 넣을 것(확실한 것만).

작업 기록(works) — 이벤트와 별도로, 현장에서 실제 수행된 '작업' 단위로 정리:
- 작업 하나 = 같은 장소·같은 업체의 같은 일. 시작 보고·중간 보고·완료 보고가 여러 메시지에 흩어져 있어도 반드시 한 건으로 합칠 것(중복 금지).
- start: 작업 시작을 알린 메시지 시각(HH:MM). 시작 언급이 없으면 그 작업 관련 첫 메시지 시각을 쓰고 features에 "(시작 시각은 첫 언급 기준)"이라고 적을 것. 전혀 없으면 "".
- end: 종료·완료·철수 보고 시각(HH:MM). 아직 안 끝났으면 "".
- status: 예정(앞으로 할 일) / 진행(시작했으나 종료 보고 없음) / 완료 / 중단(중지·보류·취소).
- features: 작업 특징을 짧게 — 작업 방식, 위험요소(고소·화기·밀폐·중량물 등), 허가·입회 여부, 특이사항·지연 사유.
- people: 투입 인원(언급된 경우, 예 "5명"), equipment: 장비(크레인 50t 등). 없으면 "".
- place: 위치(층·구역·설비명), company: 업체/팀. 없으면 "".
- 아래 '전날까지 끝나지 않은 작업' 중 오늘 대화에서 종료·완료·중단이 확인되면 works에 새로 넣지 말고 works_update에 그 id와 end 시각·status를 넣을 것. 오늘도 계속 진행 중이면 아무것도 하지 말 것(중복 생성 금지).

전날까지 끝나지 않은 작업:
${prevWorkList}

이전 미결 목록:
${prevList}

---
${convo}
---`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'works', 'works_update', 'events', 'resolved_prev'],
    properties: {
      summary: { type: 'string' },
      works: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['room', 'title', 'place', 'company', 'start', 'end', 'status', 'features', 'people', 'equipment'],
          properties: {
            room: { type: 'string' }, title: { type: 'string' }, place: { type: 'string' }, company: { type: 'string' },
            start: { type: 'string' }, end: { type: 'string' },
            status: { type: 'string', enum: KAKAO_WORK_STATUS },
            features: { type: 'string' }, people: { type: 'string' }, equipment: { type: 'string' },
          },
        },
      },
      works_update: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'end', 'status', 'evidence'],
          properties: { id: { type: 'integer' }, end: { type: 'string' }, status: { type: 'string', enum: KAKAO_WORK_STATUS }, evidence: { type: 'string' } },
        },
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['room', 'kind', 'title', 'detail', 'who', 'at', 'status'],
          properties: {
            room: { type: 'string' },
            kind: { type: 'string', enum: KAKAO_EVENT_KINDS },
            title: { type: 'string' },
            detail: { type: 'string' },
            who: { type: 'string' },
            at: { type: 'string' },
            status: { type: 'string', enum: ['open', 'done'] },
          },
        },
      },
      resolved_prev: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'evidence'],
          properties: { id: { type: 'integer' }, evidence: { type: 'string' } },
        },
      },
    },
  };

  const model = 'claude-opus-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      fallbacks: 'default', // 안전분류기 거절 시 서버가 다른 모델로 자동 재시도
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: 'anthropic_error', detail: data };
  if (data.stop_reason === 'refusal') return { ok: false, error: 'refused', detail: data.stop_details || null };
  if (data.stop_reason === 'max_tokens') return { ok: false, error: 'output_too_long' };
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let parsed;
  try { parsed = JSON.parse(textBlock ? textBlock.text : ''); } catch (e) { return { ok: false, error: 'bad_ai_json' }; }

  const prevIds = new Set(prevR.results.map(e => e.id));
  // 사람이 이미 체크한 항목과 같은 이벤트는 다시 만들지 않는다(재분석 시 중복 방지)
  const manualR = await db.prepare(`SELECT room, kind, title FROM kakao_events WHERE day=? AND manual=1`).bind(day).all();
  const manualKeys = new Set(manualR.results.map(e => `${e.room}|${e.kind}|${e.title}`));
  const manualWorkR = await db.prepare(`SELECT wkey FROM kakao_works WHERE day=? AND manual=1`).bind(day).all();
  const seenWork = new Set(manualWorkR.results.map(w => w.wkey));
  const prevWorkIds = new Set(prevWorkR.results.map(w => w.id));
  const hhmm = (s) => (/^\d{1,2}:\d{2}$/.test(String(s || '').trim()) ? String(s).trim().padStart(5, '0') : '');
  const stmts = [
    db.prepare(`DELETE FROM kakao_works WHERE day=? AND manual=0`).bind(day),
    // 다시 분석하면 그날 자동 생성분은 교체하되, 사람이 체크한(manual) 항목은 보존
    db.prepare(`DELETE FROM kakao_events WHERE day=? AND manual=0`).bind(day),
    db.prepare(`INSERT INTO kakao_analysis(day, summary, msg_count, truncated, model, analyzed_at) VALUES(?,?,?,?,?,?)
                ON CONFLICT(day) DO UPDATE SET summary=excluded.summary, msg_count=excluded.msg_count, truncated=excluded.truncated, model=excluded.model, analyzed_at=excluded.analyzed_at`)
      .bind(day, parsed.summary || '', msgs.length, truncated ? 1 : 0, data.model || model, now.ts),
  ];
  const seenEv = new Set();
  for (const e of parsed.events || []) {
    if (manualKeys.has(`${e.room}|${e.kind}|${e.title}`)) continue;
    const ek = workKey(e.room, e.kind + e.title);
    if (seenEv.has(ek)) continue; // 같은 이벤트 중복 방지
    seenEv.add(ek);
    stmts.push(db.prepare(`INSERT INTO kakao_events(day, room, kind, title, detail, who, at, status, manual, updated_at) VALUES(?,?,?,?,?,?,?,?,0,?)`)
      .bind(day, e.room, e.kind, e.title, e.detail, e.who, e.at, e.status === 'done' ? 'done' : 'open', now.ts));
  }
  // 작업 기록: 같은 방·같은 작업명은 한 건만 (AI가 합치지 못한 경우의 안전장치 — 시각·특징은 병합)
  const works = [];
  const byKey = {};
  for (const w of parsed.works || []) {
    const key = workKey(w.room, w.title);
    if (seenWork.has(key)) continue; // 사람이 수정한 기록이 이미 있음
    const s = hhmm(w.start), e = hhmm(w.end);
    if (byKey[key]) {
      const a = byKey[key];
      if (s && (!a.start || s < a.start)) a.start = s;
      if (e && (!a.end || e > a.end)) a.end = e;
      if (w.status === '완료' || w.status === '중단') a.status = w.status;
      if (w.features && !a.features.includes(w.features)) a.features += (a.features ? ' / ' : '') + w.features;
      for (const f of ['place', 'company', 'people', 'equipment']) if (!a[f] && w[f]) a[f] = w[f];
      continue;
    }
    byKey[key] = { ...w, key, start: s, end: e, features: w.features || '' };
    works.push(byKey[key]);
  }
  for (const w of works) {
    stmts.push(db.prepare(`INSERT INTO kakao_works(day, room, wkey, title, place, company, start_at, end_at, status, features, people, equipment, manual, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
      .bind(day, w.room, w.key, w.title, w.place || '', w.company || '', w.start, w.end, KAKAO_WORK_STATUS.includes(w.status) ? w.status : '진행', w.features, w.people || '', w.equipment || '', now.ts));
  }
  let worksClosed = 0;
  for (const u of parsed.works_update || []) {
    if (!prevWorkIds.has(u.id)) continue; // 목록에 없던 id는 무시(환각 방어)
    worksClosed++;
    stmts.push(db.prepare(`UPDATE kakao_works SET status=?, end_at=?, note=?, updated_at=? WHERE id=? AND manual=0`)
      .bind(KAKAO_WORK_STATUS.includes(u.status) ? u.status : '완료', `${day.slice(5)} ${hhmm(u.end) || ''}`.trim(), `${day} 대화에서 종료 확인: ${String(u.evidence).slice(0, 200)}`, now.ts, u.id));
  }

  let resolved = 0;
  for (const rp of parsed.resolved_prev || []) {
    if (!prevIds.has(rp.id)) continue; // 목록에 없던 id는 무시(환각 방어)
    resolved++;
    stmts.push(db.prepare(`UPDATE kakao_events SET status='done', note=?, updated_at=? WHERE id=? AND manual=0`)
      .bind(`${day} 대화에서 완료 확인: ${String(rp.evidence).slice(0, 200)}`, now.ts, rp.id));
  }
  await db.batch(stmts);
  return { ok: true, day, msgCount: msgs.length, works: works.length, worksClosed, events: (parsed.events || []).length, resolvedPrev: resolved, truncated, model: data.model || model };
}

/* =====================================================================
 * 현장메모 — 순시용 메모 (본문 + 엑셀 표(서식 그대로) / 이미지 블록)
 * =====================================================================
 * 원본: GitHub 0toher0/memo (Streamlit memo_attach)의 붙여넣기·렌더 방식을 앱용으로 옮김.
 * 저장소: 같은 D1(KAKAO_DB). 블록 하나 = 한 행(D1 행 크기 상한 2MB 때문에 블록별로 분리).
 * 인증(v2.9.0~): 앱 공유 토큰 또는 ADMIN_PASS — 현장톡과 동일(kakaoMemoAuthOk).
 *   GET  /memo/list?from=&to=        날짜 범위 메모 목록(블록 개수 포함)
 *   GET  /memo/note?id=              메모 + 블록 전체
 *   POST /memo/note {id?, day, title, body}   생성/수정
 *   POST /memo/note-delete {id}       메모와 블록 삭제
 *   POST /memo/block {note_id, kind:'table'|'image'|'text', caption, payload}
 *   POST /memo/note 에 rev를 같이 보내면, 다른 기기가 먼저 저장했을 때 덮어쓰지 않고 409 conflict
 *   POST /memo/block-update {id, caption?, payload?}
 *   POST /memo/block-cell {id, r, c, v}   표 한 칸만 저장(동시 체크해도 안 덮어씀)
 *   POST /memo/block-delete {id}
 *   POST /memo/block-move {id, dir:-1|1}
 */
let MEMO_SCHEMA_READY = false;
const MEMO_MAX_PAYLOAD = 1900000; // D1 행 크기 상한(2,000,000 bytes) 아래로

async function memoSchema(db) {
  if (MEMO_SCHEMA_READY) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS memo_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, title TEXT, body TEXT, created_at TEXT, updated_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_memo_notes_day ON memo_notes(day)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS memo_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, caption TEXT, payload TEXT NOT NULL, created_at TEXT, updated_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_memo_blocks_note ON memo_blocks(note_id, ord)`),
  ]);
  // v2.8.0: 관리자 전용 참고문서(법령정리 중 Role별·판례·회의대응 등 — 공개 저장소에 두지 않는 내용)
  await db.prepare(`CREATE TABLE IF NOT EXISTS admin_docs (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT)`).run();
  // v2.7.0: 제목·본문 동시 수정 감지용 버전 번호 (이미 있으면 에러 → 무시)
  try { await db.prepare(`ALTER TABLE memo_notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`).run(); } catch (e) { /* 이미 있음 */ }
  MEMO_SCHEMA_READY = true;
}

async function handleMemo(request, env, url, cors) {
  const sub = url.pathname.replace(/^\/+/, '').split('/')[1] || '';
  let body = Object.fromEntries(url.searchParams.entries());
  if (request.method === 'POST') {
    try { Object.assign(body, await request.json()); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
  }
  if (!kakaoMemoAuthOk(request, env, body)) return json({ error: 'auth_failed' }, 401, cors); // 관리자 암호 불필요(앱 토큰)
  if (!env.KAKAO_DB) return json({ error: 'kakao_db_not_bound' }, 500, cors);
  const db = env.KAKAO_DB;
  await memoSchema(db);
  const now = kstNow();
  const needPost = () => request.method !== 'POST' ? json({ error: 'method_not_allowed' }, 405, cors) : null;

  if (sub === 'list') {
    const from = String(body.from || '2000-01-01'), to = String(body.to || '2999-12-31');
    const r = await db.prepare(`SELECT n.id, n.day, n.title, substr(n.body,1,80) AS preview, n.updated_at,
        (SELECT COUNT(*) FROM memo_blocks b WHERE b.note_id=n.id AND b.kind='table') AS tables,
        (SELECT COUNT(*) FROM memo_blocks b WHERE b.note_id=n.id AND b.kind='image') AS images
      FROM memo_notes n WHERE n.day BETWEEN ? AND ? ORDER BY n.day DESC, n.id DESC`).bind(from, to).all(); // 개수 제한 없음 — 오래된 메모도 항상 목록에
    return json({ today: now.day, notes: r.results }, 200, cors);
  }

  if (sub === 'note' && request.method === 'GET') {
    const id = parseInt(body.id, 10);
    const [n, b] = await db.batch([
      db.prepare(`SELECT * FROM memo_notes WHERE id=?`).bind(id),
      db.prepare(`SELECT id, ord, kind, caption, payload, updated_at FROM memo_blocks WHERE note_id=? ORDER BY ord, id`).bind(id),
    ]);
    if (!n.results[0]) return json({ error: 'not_found' }, 404, cors);
    return json({ note: n.results[0], blocks: b.results.map(x => ({ ...x, payload: JSON.parse(x.payload) })) }, 200, cors);
  }

  if (sub === 'note') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || '')) ? body.day : now.day;
    const title = String(body.title || '').slice(0, 200), text = String(body.body || '').slice(0, 200000);
    const id = parseInt(body.id, 10);
    if (id) {
      // 동시 수정 방지: 앱이 마지막으로 받은 rev와 같을 때만 덮어쓴다.
      // 다른 기기가 먼저 저장해 rev가 올라갔으면 덮어쓰지 않고 conflict + 서버 최신본을 돌려준다.
      const baseRev = body.rev === undefined || body.rev === null ? null : parseInt(body.rev, 10);
      const r = baseRev === null
        ? await db.prepare(`UPDATE memo_notes SET day=?, title=?, body=?, rev=rev+1, updated_at=? WHERE id=?`).bind(day, title, text, now.ts, id).run()
        : await db.prepare(`UPDATE memo_notes SET day=?, title=?, body=?, rev=rev+1, updated_at=? WHERE id=? AND rev=?`).bind(day, title, text, now.ts, id, baseRev).run();
      const cur = await db.prepare(`SELECT * FROM memo_notes WHERE id=?`).bind(id).first();
      if (!cur) return json({ error: 'not_found' }, 404, cors);
      if (!r.meta.changes) return json({ error: 'conflict', note: cur }, 409, cors);
      return json({ ok: true, id, rev: cur.rev }, 200, cors);
    }
    const r = await db.prepare(`INSERT INTO memo_notes(day, title, body, created_at, updated_at) VALUES(?,?,?,?,?)`).bind(day, title, text, now.ts, now.ts).run();
    return json({ ok: true, id: r.meta.last_row_id, rev: 0 }, 200, cors);
  }

  if (sub === 'note-delete') {
    const e = needPost(); if (e) return e;
    const id = parseInt(body.id, 10);
    await db.batch([
      db.prepare(`DELETE FROM memo_blocks WHERE note_id=?`).bind(id),
      db.prepare(`DELETE FROM memo_notes WHERE id=?`).bind(id),
    ]);
    return json({ ok: true }, 200, cors);
  }

  if (sub === 'block') {
    const e = needPost(); if (e) return e;
    const noteId = parseInt(body.note_id, 10);
    const kind = ['table', 'image', 'text'].includes(body.kind) ? body.kind : null;
    if (!noteId || !kind || !body.payload) return json({ error: 'bad_payload' }, 400, cors);
    const payload = JSON.stringify(body.payload);
    if (payload.length > MEMO_MAX_PAYLOAD) return json({ error: 'too_large', bytes: payload.length, max: MEMO_MAX_PAYLOAD }, 413, cors);
    const mx = await db.prepare(`SELECT COALESCE(MAX(ord),0) AS m FROM memo_blocks WHERE note_id=?`).bind(noteId).first();
    const r = await db.prepare(`INSERT INTO memo_blocks(note_id, ord, kind, caption, payload, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(noteId, (mx ? mx.m : 0) + 1, kind, String(body.caption || '').slice(0, 300), payload, now.ts, now.ts).run();
    await db.prepare(`UPDATE memo_notes SET updated_at=? WHERE id=?`).bind(now.ts, noteId).run();
    return json({ ok: true, id: r.meta.last_row_id }, 200, cors);
  }

  if (sub === 'block-update') {
    const e = needPost(); if (e) return e;
    const id = parseInt(body.id, 10);
    const cur = await db.prepare(`SELECT * FROM memo_blocks WHERE id=?`).bind(id).first();
    if (!cur) return json({ error: 'not_found' }, 404, cors);
    const payload = body.payload !== undefined ? JSON.stringify(body.payload) : cur.payload;
    if (payload.length > MEMO_MAX_PAYLOAD) return json({ error: 'too_large' }, 413, cors);
    const caption = body.caption !== undefined ? String(body.caption).slice(0, 300) : cur.caption;
    await db.batch([
      db.prepare(`UPDATE memo_blocks SET caption=?, payload=?, updated_at=? WHERE id=?`).bind(caption, payload, now.ts, id),
      db.prepare(`UPDATE memo_notes SET updated_at=? WHERE id=?`).bind(now.ts, cur.note_id),
    ]);
    return json({ ok: true, id }, 200, cors);
  }

  // 표 한 칸만 저장 (순시 체크). 서버에서 최신 표를 읽어 그 칸만 바꾸므로
  // 두 기기에서 서로 다른 칸을 동시에 체크해도 서로 덮어쓰지 않는다.
  if (sub === 'block-cell') {
    const e = needPost(); if (e) return e;
    const id = parseInt(body.id, 10), r = parseInt(body.r, 10), c = parseInt(body.c, 10);
    const cur = await db.prepare(`SELECT * FROM memo_blocks WHERE id=? AND kind='table'`).bind(id).first();
    if (!cur) return json({ error: 'not_found' }, 404, cors);
    const p = JSON.parse(cur.payload);
    const cell = p.grid && p.grid[r] && p.grid[r][c];
    if (!cell) return json({ error: 'bad_cell' }, 400, cors);
    cell.v = String(body.v == null ? '' : body.v).slice(0, 2000);
    await db.batch([
      db.prepare(`UPDATE memo_blocks SET payload=?, updated_at=? WHERE id=?`).bind(JSON.stringify(p), now.ts, id),
      db.prepare(`UPDATE memo_notes SET updated_at=? WHERE id=?`).bind(now.ts, cur.note_id),
    ]);
    return json({ ok: true, id, r, c, v: cell.v }, 200, cors);
  }

  if (sub === 'block-delete') {
    const e = needPost(); if (e) return e;
    await db.prepare(`DELETE FROM memo_blocks WHERE id=?`).bind(parseInt(body.id, 10)).run();
    return json({ ok: true }, 200, cors);
  }

  if (sub === 'block-move') {
    const e = needPost(); if (e) return e;
    const id = parseInt(body.id, 10), dir = body.dir === -1 || body.dir === '-1' ? -1 : 1;
    const cur = await db.prepare(`SELECT id, note_id, ord FROM memo_blocks WHERE id=?`).bind(id).first();
    if (!cur) return json({ error: 'not_found' }, 404, cors);
    const nb = await db.prepare(dir < 0
      ? `SELECT id, ord FROM memo_blocks WHERE note_id=? AND ord<? ORDER BY ord DESC LIMIT 1`
      : `SELECT id, ord FROM memo_blocks WHERE note_id=? AND ord>? ORDER BY ord ASC LIMIT 1`).bind(cur.note_id, cur.ord).first();
    if (!nb) return json({ ok: true, moved: false }, 200, cors);
    await db.batch([
      db.prepare(`UPDATE memo_blocks SET ord=? WHERE id=?`).bind(nb.ord, cur.id),
      db.prepare(`UPDATE memo_blocks SET ord=? WHERE id=?`).bind(cur.ord, nb.id),
    ]);
    return json({ ok: true, moved: true }, 200, cors);
  }

  // 관리자 전용 참고문서 조회 GET /memo/admin-doc?key=legal (내용은 wrangler로 D1에 직접 넣음)
  if (sub === 'admin-doc') {
    const row = await db.prepare(`SELECT json, updated_at FROM admin_docs WHERE key=?`).bind(String(body.key || '')).first();
    if (!row) return json({ error: 'not_found' }, 404, cors);
    return json({ key: body.key, updated_at: row.updated_at, doc: JSON.parse(row.json) }, 200, cors);
  }

  return json({ error: 'unknown_memo_route', sub }, 404, cors);
}