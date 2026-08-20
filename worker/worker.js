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
        version: '2.0.0',
        env: {
          DATA_GO_KR_KEY: env.DATA_GO_KR_KEY ? 'set' : 'MISSING',
          SHARED_TOKEN: env.SHARED_TOKEN ? 'set' : 'MISSING',
          ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || '(open: all origins)',
          ADMIN_PASS: env.ADMIN_PASS ? 'set' : 'MISSING',
          TBM_KV: env.TBM_KV ? 'bound' : 'MISSING',
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
