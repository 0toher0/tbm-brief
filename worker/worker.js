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
 *   [Secret] GEMINI_API_KEY   : (선택) 엑셀 표 형식이 달라 자동인식 실패 시 AI로 대신 추출하는 /parse-ai용.
 *                               aistudio.google.com/apikey 에서 무료로 발급(신용카드 불필요,
 *                               발급 시 화면에서 재확인). 없으면 /parse-ai는 ai_not_configured 에러만
 *                               반환하고 나머지 기능(날씨/공용작업)은 그대로 동작함.
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
  async fetch(request, env) {
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
        version: '2.1.0',
        env: {
          DATA_GO_KR_KEY: env.DATA_GO_KR_KEY ? 'set' : 'MISSING',
          SHARED_TOKEN: env.SHARED_TOKEN ? 'set' : 'MISSING',
          ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || '(open: all origins)',
          ADMIN_PASS: env.ADMIN_PASS ? 'set' : 'MISSING',
          TBM_KV: env.TBM_KV ? 'bound' : 'MISSING',
          GEMINI_API_KEY: env.GEMINI_API_KEY ? 'set' : 'MISSING (optional — /parse-ai만 영향)',
        },
      }, 200, cors);
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

    // ===== AI 기반 작업표 파싱 (Gemini API, 무료 등급) =====
    // POST /parse-ai  body: { text: "<붙여넣은 원본 텍스트>" }
    // 결정론적 파서(parsePaste, 앱 쪽)가 실패했을 때만 클라이언트가 호출하는 폴백.
    // 스키마 강제(responseSchema)는 출처마다 표기법(대문자/소문자 type)이 달라 신뢰도가
    // 낮아서 안 쓰고, 프롬프트에 원하는 JSON 구조를 명시 + responseMimeType만 사용한다.
    // 응답은 클라이언트의 normalizeAiRows()가 필드 누락을 방어하므로 여기선 그대로 통과시킨다.
    if (path0 === 'parse-ai') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
      if (!env.GEMINI_API_KEY) return json({ error: 'ai_not_configured' }, 500, cors);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
      const text = String(body.text || '').slice(0, 20000); // 과금(및 무료 등급 토큰 한도) 방지용 길이 상한
      if (!text.trim()) return json({ error: 'empty_text' }, 400, cors);

      const prompt = `아래는 건설현장 TBM(작업 전 안전미팅)용으로 붙여넣은 작업표입니다. 엑셀에서 복사한 표라 형식이 정형화되어 있지 않을 수 있습니다. 표에 있는 각 작업 행을 정확히 추출해서, 다음 JSON 형식으로만 응답하세요(다른 텍스트 없이 JSON만):

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
        const model = 'gemini-2.5-flash-lite';
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });
        const data = await r.json();
        if (!r.ok) return json({ error: 'gemini_error', detail: data }, 502, cors);
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) return json({ error: 'no_structured_output', detail: data }, 502, cors);
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
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
